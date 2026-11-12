/**
 * Host-half smoke test: registers the real `apply`, then drives the HTTP
 * endpoint with the Connection services stubbed and a scripted model, so the
 * whole request path runs without booting Harness.
 *
 * Run: node test/smoke-host.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPredictions } from '../lib/predictions.js'
import * as mod from '../index.js'

const ROUTE = '/composer-prefill/predict'
const CSRF = 'x-dsh-composer-prefill'

/**
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [input] request shape.
 * @returns {{ req: any, emit: () => void }} a stand-in IncomingMessage.
 */
function fakeRequest({ method = 'POST', headers = {}, body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.destroy = () => {}
  return {
    req,
    emit() {
      if (body !== '') req.emit('data', Buffer.from(body))
      req.emit('end')
    },
  }
}

/**
 * @returns {{ res: any }} a stand-in ServerResponse.
 */
function fakeResponse() {
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      res.statusCode = status
      for (const [name, value] of Object.entries(headers ?? {})) res.headers[name.toLowerCase()] = value
      res.headersSent = true
    },
    end(payload) {
      res.writableEnded = true
      if (payload !== undefined) res.body = String(payload)
    },
  }
  return { res }
}

/**
 * Build a stand-in prepared call that enforces the dispatch invariant.
 *
 * @param {Record<string, unknown>} config the config handed to `prepareCall`.
 * @param {unknown[]} chunks the chunk sequence to replay.
 * @returns {{ config: object, stream: (options: Record<string, unknown>) => AsyncIterable<unknown> }} prepared call.
 */
function prepared(config, chunks) {
  const resolved = {}
  for (const key of ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']) {
    if (config[key] !== undefined) resolved[key] = config[key]
  }
  return {
    config: resolved,
    stream(options) {
      for (const key of ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']) {
        if (options[key] !== resolved[key]) throw new Error(`prepared LLM call config changed before adapter dispatch (${key})`)
      }
      return (async function* replay() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/**
 * @param {{ admit?: () => unknown }} [overrides] service overrides.
 * @returns {{ ctx: object, routes: any[], calls: { prepare: number } }} harness.
 */
function harness({ admit } = {}) {
  const routes = []
  const calls = { prepare: 0 }
  const session = {
    seq: 42,
    requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  const ctx = {
    sessions: {
      get: () => session,
    },
    connection: {
      admit: admit ?? (() => ({ peer: { principal: { kind: 'owner' } } })),
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
    llm: {
      // Mirrors the shipped prepared-call contract: the config chosen here is
      // snapshotted, and dispatch refuses options that disagree with it.
      prepareCall: async (config) => {
        calls.prepare += 1
        return prepared(config, [
          { type: 'text-delta', text: '继续，把测试跑一遍' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])
      },
    },
    effect: (fn) => fn(),
  }
  return { ctx, routes, calls, session }
}

/**
 * @param {any} ctx harness context.
 * @param {unknown} config plugin config.
 * @returns {Promise<{ status: number, json: any }>} response summary.
 */
async function callPost(harnessed, options = {}) {
  const handler = harnessed.routes[0].handler
  const { req, emit } = fakeRequest({
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', [CSRF]: '1', ...(options.headers ?? {}) },
    body: options.body ?? JSON.stringify({ sessionId: 's1' }),
  })
  const { res } = fakeResponse()
  const pending = handler(req, res)
  emit()
  await pending
  return { status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

// 1. Declared services.
{
  for (const service of ['sessions', 'connection', 'webServer', 'llm', 'agentDefaultModel']) {
    assert.ok(mod.inject.includes(service), `inject declares ${service}`)
  }
  console.log('ok inject:', mod.inject.join(', '))
}

// 2. Registration: exactly one exact route at the expected path.
{
  const { ctx, routes } = harness()
  mod.apply(ctx, { showPredictions: true })
  assert.equal(routes.length, 1, 'registers exactly one route')
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, ROUTE)
  console.log('ok route:', routes[0].path)
}

// 3. Guards: method, CSRF, trust, ownership, malformed body.
{
  const guarded = harness()
  mod.apply(guarded.ctx, { showPredictions: true })

  const wrongMethod = await callPost(guarded, { method: 'GET' })
  assert.equal(wrongMethod.status, 405, 'GET is rejected')

  const noCsrf = await callPost(guarded, { headers: { [CSRF]: '0' } })
  assert.equal(noCsrf.status, 403, 'missing CSRF proof is rejected')

  const rejected = harness({ admit: () => ({ rejection: 401 }) })
  mod.apply(rejected.ctx, { showPredictions: true })
  const untrusted = await callPost(rejected)
  assert.equal(untrusted.status, 401, 'a refused admission keeps its status')

  const foreign = harness({ admit: () => ({ peer: { principal: { kind: 'api' } } }) })
  mod.apply(foreign.ctx, { showPredictions: true })
  const notOwner = await callPost(foreign)
  assert.equal(notOwner.status, 403, 'only the owner principal may predict')

  const badBody = await callPost(guarded, { body: '{nope' })
  assert.equal(badBody.status, 400, 'malformed JSON is rejected')
  console.log('ok guards: method / CSRF / trust / owner / body')
}

// 4. End to end: one suggestion, sanitized and single-line.
{
  const live = harness()
  mod.apply(live.ctx, { showPredictions: true, minIntervalMs: 0 })
  const first = await callPost(live)
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.value.enabled, true)
  assert.equal(first.json.value.text, '继续，把测试跑一遍')
  assert.equal(live.calls.prepare, 1, 'one model call per prediction')

  const second = await callPost(live)
  assert.equal(second.json.value.cached, true, 'same session offset is served from cache')
  assert.equal(live.calls.prepare, 1, 'the cache prevents a second model call')
  console.log('ok end to end + cache')
}

// 4b. `mode: "cached"` replays only a fresh cache entry and never generates.
{
  const cold = harness()
  mod.apply(cold.ctx, { showPredictions: true, minIntervalMs: 0 })
  const missed = await callPost(cold, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(missed.status, 200)
  assert.equal(missed.json.value.text, null, 'a cold cache serves nothing')
  assert.equal(cold.calls.prepare, 0, 'a cached lookup never calls the model')

  const warm = harness()
  mod.apply(warm.ctx, { showPredictions: true, minIntervalMs: 0 })
  await callPost(warm) // populates the cache for seq 42
  assert.equal(warm.calls.prepare, 1)
  const replayed = await callPost(warm, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(replayed.json.value.text, '继续，把测试跑一遍', 'a warm cache replays the suggestion')
  assert.equal(replayed.json.value.cached, true)
  assert.equal(warm.calls.prepare, 1, 'the replay costs no model call')

  warm.session.seq = 43
  const stale = await callPost(warm, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(stale.json.value.text, null, 'a suggestion from an older turn is not replayed')
  assert.equal(warm.calls.prepare, 1, 'the stale lookup still costs no model call')
  console.log('ok cached replay: cold miss / warm hit / stale drop')
}

// 5. Kill switch, non-stop finish and throttling all yield no text.
{
  const off = harness()
  mod.apply(off.ctx, { showPredictions: false })
  const disabled = await callPost(off)
  assert.equal(disabled.json.value.enabled, false)
  assert.equal(disabled.json.value.text, null)
  assert.equal(off.calls.prepare, 0, 'the kill switch makes no model call')

  const cut = harness()
  cut.ctx.llm.prepareCall = async (config) =>
    prepared(config, [
      { type: 'text-delta', text: 'half a thought' },
      { type: 'finish', reason: { kind: 'aborted' } },
    ])
  mod.apply(cut.ctx, { showPredictions: true, minIntervalMs: 0 })
  const aborted = await callPost(cut)
  assert.equal(aborted.json.value.text, null, 'an aborted finish is discarded')

  const truncated = harness()
  truncated.ctx.llm.prepareCall = async (config) =>
    prepared(config, [
      { type: 'text-delta', text: '继续，把测试跑一' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
  mod.apply(truncated.ctx, { showPredictions: true, minIntervalMs: 0 })
  const cutOff = await callPost(truncated)
  assert.equal(cutOff.json.value.text, '继续，把测试跑一', 'a max-tokens finish still yields its first line')

  const slow = harness()
  mod.apply(slow.ctx, { showPredictions: true, minIntervalMs: 60_000 })
  await callPost(slow)
  slow.session.seq = 43
  const throttled = await callPost(slow)
  assert.equal(throttled.json.value.text, null, 'second request inside the interval is dropped')
  console.log('ok kill switch / non-stop finish / throttle')
}

// 6. Policy unit: a failing generator stays a success union with no text.
{
  const { ctx } = harness()
  const failed = await createPredictions(ctx, { showPredictions: true }, () => Promise.reject(new Error('boom'))).handle({ sessionId: 's1' }, undefined)
  assert.equal(failed.ok, true)
  assert.equal(failed.value.text, null)
  console.log('ok failing generator -> text null')
}

console.log('\nhost smoke: all checks passed')
