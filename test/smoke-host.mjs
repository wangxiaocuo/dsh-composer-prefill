/**
 * Host-half smoke test: registers the real `apply`, then drives both HTTP
 * endpoints with the Connection services stubbed and a scripted model, so the
 * whole request path runs without booting Harness.
 *
 * Run: node test/smoke-host.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPredictions } from '../lib/predictions.js'
import * as mod from '../index.js'

const PREDICT = '/composer-prefill/predict'
const PREFS = '/composer-prefill/prefs'
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
 * @param {{ admit?: () => unknown, script?: unknown[] }} [overrides] service overrides.
 * @returns {{ ctx: object, routes: any[], calls: { prepare: number }, session: object }} harness.
 */
function harness({ admit, script } = {}) {
  const routes = []
  const calls = { prepare: 0 }
  const session = {
    seq: 42,
    requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  const ctx = {
    sessions: { get: () => session },
    connection: { admit: admit ?? (() => ({ peer: { principal: { kind: 'owner' } } })) },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
    llm: {
      prepareCall: async (config) => {
        calls.prepare += 1
        return prepared(
          config,
          script ?? [
            { type: 'text-delta', text: '继续，把测试跑一遍' },
            { type: 'finish', reason: { kind: 'stop' } },
          ],
        )
      },
    },
    fiber: { entry: { options: { id: 'include:composer-prefill' } } },
    effect: (fn) => fn(),
  }
  return { ctx, routes, calls, session }
}

/**
 * @param {object} harnessed harness instance.
 * @param {string} path route path.
 * @returns {Function} the route handler.
 */
function handlerFor(harnessed, path) {
  const route = harnessed.routes.find((candidate) => candidate.path === path)
  assert.ok(route, `route ${path} is registered`)
  return route.handler
}

/**
 * @param {object} harnessed harness instance.
 * @param {{ path?: string, method?: string, headers?: Record<string, string>, body?: string }} [options] request shape.
 * @returns {Promise<{ status: number, json: any }>} response summary.
 */
async function call(harnessed, options = {}) {
  const path = options.path ?? PREDICT
  const { req, emit } = fakeRequest({
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', [CSRF]: '1', ...(options.headers ?? {}) },
    body: options.body ?? (path === PREFS ? '{}' : JSON.stringify({ sessionId: 's1' })),
  })
  const { res } = fakeResponse()
  const pending = handlerFor(harnessed, path)(req, res)
  emit()
  await pending
  return { status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

// 1. Declared services and both routes.
{
  for (const service of ['sessions', 'connection', 'webServer', 'llm', 'agentDefaultModel']) {
    assert.ok(mod.inject.includes(service), `inject declares ${service}`)
  }
  const { ctx, routes } = harness()
  mod.apply(ctx, { showPredictions: true })
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [PREDICT, PREFS],
    'both endpoints are registered as exact routes',
  )
  assert.ok(routes.every((route) => route.kind === 'exact'))
  console.log('ok inject + routes:', mod.inject.join(', '))
}

// 2. Guards: method, CSRF, trust, ownership, malformed body.
{
  const guarded = harness()
  mod.apply(guarded.ctx, { showPredictions: true })

  assert.equal((await call(guarded, { method: 'GET' })).status, 405, 'GET is rejected')
  assert.equal((await call(guarded, { headers: { [CSRF]: '0' } })).status, 403, 'missing CSRF proof is rejected')

  const rejected = harness({ admit: () => ({ rejection: 401 }) })
  mod.apply(rejected.ctx, { showPredictions: true })
  assert.equal((await call(rejected)).status, 401, 'a refused admission keeps its status')

  const foreign = harness({ admit: () => ({ peer: { principal: { kind: 'api' } } }) })
  mod.apply(foreign.ctx, { showPredictions: true })
  assert.equal((await call(foreign)).status, 403, 'only the owner principal may predict')

  assert.equal((await call(guarded, { body: '{nope' })).status, 400, 'malformed JSON is rejected')
  assert.equal((await call(guarded, { path: PREFS, method: 'GET' })).status, 405, 'prefs rejects GET too')
  console.log('ok guards: method / CSRF / trust / owner / body (both endpoints)')
}

// 3. End to end: one suggestion, sanitized, cached by session offset.
{
  const live = harness()
  mod.apply(live.ctx, { showPredictions: true, minIntervalMs: 0 })

  const first = await call(live)
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.value.enabled, true)
  assert.equal(first.json.value.text, '继续，把测试跑一遍')
  assert.equal(live.calls.prepare, 1, 'one model call per prediction')

  const second = await call(live)
  assert.equal(second.json.value.cached, true, 'same session offset is served from cache')
  assert.equal(live.calls.prepare, 1, 'the cache prevents a second model call')
  console.log('ok end to end + cache')
}

// 4. `mode: "cached"` replays only a fresh cache entry and never generates.
{
  const cold = harness()
  mod.apply(cold.ctx, { showPredictions: true, minIntervalMs: 0 })
  const missed = await call(cold, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(missed.json.value.text, null, 'a cold cache serves nothing')
  assert.equal(cold.calls.prepare, 0, 'a cached lookup never calls the model')

  const warm = harness()
  mod.apply(warm.ctx, { showPredictions: true, minIntervalMs: 0 })
  await call(warm)
  const replayed = await call(warm, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(replayed.json.value.text, '继续，把测试跑一遍', 'a warm cache replays the suggestion')
  assert.equal(replayed.json.value.cached, true)
  assert.equal(warm.calls.prepare, 1, 'the replay costs no model call')

  warm.session.seq = 43
  const stale = await call(warm, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(stale.json.value.text, null, 'a suggestion from an older turn is not replayed')
  assert.equal(warm.calls.prepare, 1, 'the stale lookup still costs no model call')
  console.log('ok cached replay: cold miss / warm hit / stale drop')
}

// 5. `mode: "refresh"` regenerates even with a fresh cache and inside the interval.
{
  const refreshed = harness()
  mod.apply(refreshed.ctx, { showPredictions: true, minIntervalMs: 60_000 })
  const first = await call(refreshed)
  assert.equal(first.json.value.text, '继续，把测试跑一遍')

  refreshed.ctx.llm.prepareCall = async (config) => {
    refreshed.calls.prepare += 1
    return prepared(config, [
      { type: 'text-delta', text: '换一条试试' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }
  const rerolled = await call(refreshed, { body: JSON.stringify({ sessionId: 's1', mode: 'refresh' }) })
  assert.equal(rerolled.json.value.text, '换一条试试', 'a refresh bypasses the cache')
  assert.equal(rerolled.json.value.cached, undefined, 'a refresh is never a cache hit')
  assert.equal(refreshed.calls.prepare, 2, 'the refresh costs one more model call, even inside the interval')

  const replayed = await call(refreshed, { body: JSON.stringify({ sessionId: 's1', mode: 'cached' }) })
  assert.equal(replayed.json.value.text, '换一条试试', 'the refresh replaced the cache entry')
  console.log('ok refresh: bypasses cache + interval, replaces the cache')
}

// 6. Prefs reports the switch and the Loader entry id the settings row needs.
{
  const prefs = harness()
  mod.apply(prefs.ctx, { showPredictions: false })
  const off = await call(prefs, { path: PREFS })
  assert.equal(off.json.ok, true)
  assert.equal(off.json.value.enabled, false, 'the stored switch value is reported')
  assert.equal(off.json.value.entryId, 'include:composer-prefill', 'the entry id is reported')

  const withoutEntry = harness()
  withoutEntry.ctx.fiber = undefined
  mod.apply(withoutEntry.ctx, { showPredictions: true })
  const nullEntry = await call(withoutEntry, { path: PREFS })
  assert.equal(nullEntry.json.value.entryId, null, 'a missing entry id degrades to null')
  console.log('ok prefs: enabled + entryId')
}

// 7. Kill switch, aborted finish, truncation and throttling.
{
  const off = harness()
  mod.apply(off.ctx, { showPredictions: false })
  const disabled = await call(off)
  assert.equal(disabled.json.value.enabled, false)
  assert.equal(disabled.json.value.text, null)
  assert.equal(off.calls.prepare, 0, 'the kill switch makes no model call')

  const aborted = harness({
    script: [
      { type: 'text-delta', text: 'half a thought' },
      { type: 'finish', reason: { kind: 'aborted' } },
    ],
  })
  mod.apply(aborted.ctx, { showPredictions: true, minIntervalMs: 0 })
  assert.equal((await call(aborted)).json.value.text, null, 'an aborted finish is discarded')

  const truncated = harness({
    script: [
      { type: 'text-delta', text: '继续，把测试跑一' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
  })
  mod.apply(truncated.ctx, { showPredictions: true, minIntervalMs: 0 })
  assert.equal((await call(truncated)).json.value.text, '继续，把测试跑一', 'a max-tokens finish still yields its first line')

  const slow = harness()
  mod.apply(slow.ctx, { showPredictions: true, minIntervalMs: 60_000 })
  await call(slow)
  slow.session.seq = 43
  assert.equal((await call(slow)).json.value.text, null, 'second request inside the interval is dropped')
  console.log('ok kill switch / aborted finish / truncation / throttle')
}

// 8. Policy unit: a failing generator stays a success union with no text.
{
  const { ctx } = harness()
  const failed = await createPredictions(ctx, { showPredictions: true }, { generate: () => Promise.reject(new Error('boom')) }).handle(
    { sessionId: 's1' },
    undefined,
  )
  assert.equal(failed.ok, true)
  assert.equal(failed.value.text, null)
  console.log('ok failing generator -> text null')
}

// 9. The attempt counter rises on rerolls and resets for a new turn.
{
  const { ctx, session } = harness()
  const seen = []
  const predictions = createPredictions(ctx, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (target, _signal, context) => {
      seen.push({ seq: target.seq, attempt: context.attempt })
      return Promise.resolve(`suggestion ${context.attempt}`)
    },
  })

  const first = await predictions.handle({ sessionId: 's1' }, undefined)
  assert.equal(first.value.text, 'suggestion 1', 'the first request is attempt 1')

  const rerolled = await predictions.handle({ sessionId: 's1', mode: 'refresh' }, undefined)
  assert.equal(rerolled.value.text, 'suggestion 2', 'a reroll is attempt 2')

  const again = await predictions.handle({ sessionId: 's1', mode: 'refresh' }, undefined)
  assert.equal(again.value.text, 'suggestion 3', 'further rerolls keep counting')

  session.seq = 43
  await predictions.handle({ sessionId: 's1' }, undefined)
  assert.deepEqual(
    seen.map((entry) => entry.attempt),
    [1, 2, 3, 1],
    'a new turn starts again at attempt 1',
  )
  console.log('ok attempts: 1 -> 2 -> 3, reset on a new turn')
}

console.log('\nhost smoke: all checks passed')
