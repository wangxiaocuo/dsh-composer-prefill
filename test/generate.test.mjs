/**
 * Unit tests for `lib/generate.js`: route resolution, request controls, output
 * hygiene and failure/abort propagation, with `ctx.llm` fully stubbed so no
 * model call ever leaves this process.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerator } from '../lib/generate.js'

/** Keys the prepared call pins before adapter dispatch. */
const DISPATCH_KEYS = ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']

/**
 * @param {string} type chunk type.
 * @param {unknown} [extra] extra fields.
 * @returns {object} a stream chunk.
 */
function chunk(type, extra = {}) {
  return { type, ...extra }
}

/**
 * @param {string} text assistant output.
 * @param {string} [kind] finish reason kind.
 * @returns {object[]} a scripted stream: one text delta then a finish chunk.
 */
function scripted(text, kind = 'stop') {
  return [chunk('text-delta', { text }), chunk('finish', { reason: { kind } })]
}

/**
 * @param {AbortSignal} signal a signal.
 * @returns {Promise<never>} rejects when the signal aborts.
 */
function rejectOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal === undefined) return
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

/**
 * A stream that never finishes on its own: it waits for the abort signal, then
 * rejects like a real adapter interrupted mid-call.
 *
 * @returns {(options: object) => AsyncIterable<object>} stream factory.
 */
function abortableStream() {
  return async function* stream(options) {
    yield chunk('text-delta', { text: 'half a thought' })
    await rejectOnAbort(options.signal)
  }
}

/**
 * @param {object} config pinned call config.
 * @returns {Record<string, unknown>} only the keys that were actually set.
 */
function pinnedConfig(config) {
  const resolved = {}
  for (const key of DISPATCH_KEYS) {
    if (config[key] !== undefined) resolved[key] = config[key]
  }
  return resolved
}

/**
 * A stand-in `ctx.llm` whose prepared call enforces the real dispatch
 * invariant: the stream options must agree with the pinned config.
 *
 * @param {{ chunks?: object[], model?: object, prepareError?: Error, streamError?: Error, stream?: Function }} [options] stubs.
 * @returns {{ ctx: object, calls: { prepare: object[], streams: object[], selected: object[] } }} harness.
 */
function makeCtx({ chunks = scripted('继续，把测试跑一遍'), model = { reasoning: { efforts: [{ id: 'high' }] } }, prepareError, streamError, stream: customStream } = {}) {
  const calls = { prepare: [], streams: [], selected: [] }
  const ctx = {
    llm: {
      async prepareCall(config, signal, selectModel) {
        calls.prepare.push({ config, signal })
        if (prepareError !== undefined) throw prepareError
        const selected = selectModel({ ...config }, model)
        calls.selected.push(selected)
        const resolved = pinnedConfig(selected)
        return {
          config: resolved,
          stream(streamOptions) {
            for (const key of DISPATCH_KEYS) {
              if (streamOptions[key] !== resolved[key]) {
                throw new Error(`prepared LLM call config changed before adapter dispatch (${key})`)
              }
            }
            calls.streams.push(streamOptions)
            if (customStream !== undefined) return customStream(streamOptions)
            return (async function* replay() {
              if (streamError !== undefined) throw streamError
              for (const item of chunks) yield item
            })()
          },
        }
      },
    },
  }
  return { ctx, calls }
}

/**
 * @param {{ messages?: unknown[], route?: object | null, id?: string }} [options] live-session shape.
 * @returns {object} a stand-in live session.
 */
function makeSession({ messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], route = { provider: 'session-provider', model: 'session-model' }, id = 's1' } = {}) {
  const session = {
    id,
    seq: 1,
    deriveMessages: () => messages,
  }
  if (route !== null) session.requestHeader = () => ({ config: route })
  return session
}

/**
 * Run `fn` while capturing one console method.
 *
 * @param {'log' | 'warn'} method console method.
 * @param {() => Promise<unknown>} fn body.
 * @returns {Promise<{ value: unknown, lines: unknown[][] }>} result plus captured argument lists.
 */
async function captureConsole(method, fn) {
  const lines = []
  const original = console[method]
  console[method] = (...args) => {
    lines.push(args)
  }
  try {
    return { value: await fn(), lines }
  } finally {
    console[method] = original
  }
}

/**
 * @param {object} streamOptions options handed to `call.stream`.
 * @returns {{ turns: Array<{ role: string, text: string }>, attempt: number }} decoded prompt payload.
 */
function payloadOf(streamOptions) {
  return JSON.parse(streamOptions.messages[0].content[0].text)
}

test('a complete pinned provider/model pair wins over the session route', async () => {
  const { ctx, calls } = makeCtx()
  const generate = createGenerator(ctx, { provider: '  pinned  ', model: '  pinned-model  ', maxOutputTokens: 32 })
  const text = await generate(makeSession())

  assert.equal(text, '继续，把测试跑一遍')
  assert.equal(calls.prepare.length, 1)
  assert.equal(calls.prepare[0].config.provider, 'pinned', 'the provider is trimmed')
  assert.equal(calls.prepare[0].config.model, 'pinned-model', 'the model is trimmed')
  assert.equal(calls.prepare[0].config.maxTokens, 32, 'maxOutputTokens is forwarded')
  assert.equal(calls.selected[0].reasoningEffort, 'high', 'the model selector picks the first reasoning effort')
})

test('a partial provider/model pin falls back to the session route', async () => {
  for (const config of [{ provider: 'only-provider' }, { model: 'only-model' }, { provider: '', model: 'only-model' }]) {
    const { ctx, calls } = makeCtx()
    await createGenerator(ctx, config)(makeSession())
    assert.equal(calls.prepare[0].config.provider, 'session-provider')
    assert.equal(calls.prepare[0].config.model, 'session-model')
  }
})

test('the session route comes from requestHeader().config', async () => {
  const { ctx, calls } = makeCtx()
  await createGenerator(ctx, {})(makeSession({ route: { provider: 'live-provider', model: 'live-model' } }))
  assert.equal(calls.prepare[0].config.provider, 'live-provider')
  assert.equal(calls.prepare[0].config.model, 'live-model')
})

test('the app default model is the last route source', async () => {
  const { ctx, calls } = makeCtx()
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
  await createGenerator(ctx, {})(makeSession({ route: null }))
  assert.equal(calls.prepare[0].config.provider, 'default-provider')
  assert.equal(calls.prepare[0].config.model, 'default-model')
})

test('the app default is only used when requestHeader yields no complete route', async () => {
  for (const route of [{}, { config: {} }, { config: { provider: 'half' } }, null]) {
    const { ctx, calls } = makeCtx()
    ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
    const session = makeSession()
    if (route === null) delete session.requestHeader
    else session.requestHeader = () => route
    await createGenerator(ctx, {})(session)
    assert.equal(calls.prepare[0].config.provider, 'default-provider', `route source ${JSON.stringify(route)}`)
  }
})

test('no usable route means no call at all', async () => {
  const scenarios = [
    (ctx) => {},
    (ctx) => {
      ctx.agentDefaultModel = {}
    },
    (ctx) => {
      ctx.agentDefaultModel = { currentSelection: () => null }
    },
    (ctx) => {
      ctx.agentDefaultModel = { currentSelection: () => ({}) }
    },
  ]
  for (const arrange of scenarios) {
    const { ctx, calls } = makeCtx()
    arrange(ctx)
    const text = await createGenerator(ctx, {})(makeSession({ route: null }))
    assert.equal(text, null)
    assert.equal(calls.prepare.length, 0, 'no route costs no model call')
  }
})

test('an empty conversation tail means no call at all', async () => {
  const { ctx, calls } = makeCtx()

  const noMessages = makeSession()
  delete noMessages.deriveMessages
  assert.equal(await createGenerator(ctx, {})(noMessages), null)
  assert.equal(calls.prepare.length, 0, 'a session without deriveMessages is not called')

  const noTurns = makeSession({ messages: [{ role: 'tool', content: [{ type: 'text', text: 'tool output' }] }] })
  assert.equal(await createGenerator(ctx, {})(noTurns), null)
  assert.equal(calls.prepare.length, 0, 'a conversation without user/assistant text is not called')
})

test('the prepared call pins the configured token cap and the prompt payload', async () => {
  const { ctx, calls } = makeCtx()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
  ]
  await createGenerator(ctx, { maxContextTurns: 1, maxOutputTokens: 16, maxInputChars: 4000 })(makeSession({ messages }))

  const options = calls.streams[0]
  assert.equal(calls.prepare[0].config.maxTokens, 16)
  assert.equal(options.purpose, 'composer-prefill')
  assert.match(options.system, /NONE/, 'the shipped system prompt is sent')
  assert.ok(options.signal instanceof AbortSignal, 'the call carries an abort signal')
  assert.deepEqual(payloadOf(options).turns, [
    { role: 'user', text: 'second question' },
    { role: 'assistant', text: 'second answer' },
  ])
  assert.equal(payloadOf(options).attempt, 1, 'the default attempt is 1')
})

test('the character budget trims the oldest turns', async () => {
  const { ctx, calls } = makeCtx()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(600) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(600) }] },
    { role: 'user', content: [{ type: 'text', text: 'z'.repeat(600) }] },
  ]
  await createGenerator(ctx, { maxInputChars: 600 })(makeSession({ messages }))
  const turns = payloadOf(calls.streams[0]).turns
  assert.equal(turns.length, 1, 'older turns are dropped to fit the budget')
  assert.equal(turns[0].text, 'z'.repeat(600))
})

test('missing configuration uses the documented defaults', async () => {
  const { ctx, calls } = makeCtx()
  const messages = Array.from({ length: 6 }, (_value, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `turn ${index}` }],
  }))
  await createGenerator(ctx, undefined)(makeSession({ messages }))

  assert.equal(calls.prepare[0].config.maxTokens, 64, 'default maxOutputTokens')
  assert.equal(payloadOf(calls.streams[0]).turns.length, 6, 'default maxContextTurns keeps the small tail')
  assert.equal(payloadOf(calls.streams[0]).attempt, 1)
})

test('unusable configuration values fall back to defaults', async () => {
  const { ctx, calls } = makeCtx()
  await createGenerator(ctx, { maxOutputTokens: -1, maxInputChars: -5, maxContextTurns: 'four' })(makeSession())
  assert.equal(calls.prepare[0].config.maxTokens, 64, 'negative maxOutputTokens falls back')
  assert.equal(payloadOf(calls.streams[0]).turns.length, 1, 'non-numeric maxContextTurns falls back')
})

test('live schemastery refs are unwrapped as configuration', async () => {
  const { ctx, calls } = makeCtx()
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
  ]
  await createGenerator(ctx, {
    maxOutputTokens: { get: () => 16 },
    maxContextTurns: { get: () => 1 },
    maxInputChars: { get: () => 4000 },
  })(makeSession({ messages }))

  assert.equal(calls.prepare[0].config.maxTokens, 16, 'the ref value reaches the model call')
  assert.deepEqual(payloadOf(calls.streams[0]).turns, [
    { role: 'user', text: 'q2' },
    { role: 'assistant', text: 'a2' },
  ])
})

test('the model selector omits reasoningEffort when the model has no reasoning efforts', async () => {
  const { ctx, calls } = makeCtx({ model: {} })
  await createGenerator(ctx, {})(makeSession())
  assert.equal(calls.selected[0].reasoningEffort, undefined)
  assert.deepEqual(Object.keys(calls.selected[0]).sort(), ['maxTokens', 'model', 'provider', 'reasoningEffort'])
  assert.equal(calls.prepare[0].config.maxTokens, 64)
})

test('a max-tokens finish still yields its usable first line', async () => {
  const { ctx } = makeCtx({ chunks: scripted('继续，把测试跑一', 'max-tokens') })
  assert.equal(await createGenerator(ctx, {})(makeSession()), '继续，把测试跑一')
})

test('an aborted or failed finish is discarded', async () => {
  for (const kind of ['aborted', 'error', 'tool-calls']) {
    const { ctx } = makeCtx({ chunks: scripted('half a thought', kind) })
    assert.equal(await createGenerator(ctx, {})(makeSession()), null, `finish ${kind}`)
  }
})

test('a finish without a reason, or no finish at all, is an error', async () => {
  const withoutReason = makeCtx({ chunks: [chunk('text-delta', { text: 'partial' }), chunk('finish')] })
  assert.equal(await createGenerator(withoutReason.ctx, {})(makeSession()), null)

  const noFinish = makeCtx({ chunks: [chunk('text-delta', { text: 'partial' })] })
  assert.equal(await createGenerator(noFinish.ctx, {})(makeSession()), null)
})

test('non-text chunks are ignored', async () => {
  const { ctx } = makeCtx({
    chunks: [
      chunk('reasoning-delta', { text: 'hidden thinking' }),
      chunk('usage', { inputTokens: 10 }),
      chunk('text-delta', { text: 'run the tests' }),
      chunk('text-delta', { text: ' now' }),
      chunk('finish', { reason: { kind: 'stop' } }),
    ],
  })
  assert.equal(await createGenerator(ctx, {})(makeSession()), 'run the tests now')
})

test('output hygiene trims quotes, the NONE sentinel and the length cap', async () => {
  const quoted = makeCtx({ chunks: scripted('  "继续，把测试跑一遍"  ') })
  assert.equal(await createGenerator(quoted.ctx, {})(makeSession()), '继续，把测试跑一遍')

  const none = makeCtx({ chunks: scripted('<none>') })
  assert.equal(await createGenerator(none.ctx, {})(makeSession()), null)

  const long = makeCtx({ chunks: scripted('x'.repeat(500)) })
  assert.equal((await createGenerator(long.ctx, {})(makeSession())).length, 200)
})

test('the attempt from the caller reaches the prompt payload', async () => {
  const { ctx, calls } = makeCtx()
  await createGenerator(ctx, {})(makeSession(), undefined, { attempt: 4 })
  assert.equal(payloadOf(calls.streams[0]).attempt, 4)
})

test('a provider failure rejects so the policy layer can degrade it', async () => {
  const prepareFailure = makeCtx({ prepareError: new Error('provider offline') })
  await assert.rejects(createGenerator(prepareFailure.ctx, {})(makeSession()), /provider offline/)
  assert.equal(prepareFailure.calls.streams.length, 0)

  const streamFailure = makeCtx({ streamError: new Error('stream broke') })
  await assert.rejects(createGenerator(streamFailure.ctx, {})(makeSession()), /stream broke/)
})

test('an outer abort signal cancels the in-flight call', async () => {
  const { ctx, calls } = makeCtx({ stream: abortableStream() })
  const controller = new AbortController()
  const pending = createGenerator(ctx, {})(makeSession(), controller.signal)
  controller.abort()

  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(calls.prepare[0].signal.aborted, true, 'the adapter sees the combined abort signal')
})

test('the configured timeout aborts a call that never finishes', async () => {
  const { ctx, calls } = makeCtx({ stream: abortableStream() })
  await assert.rejects(createGenerator(ctx, { timeoutMs: 10 })(makeSession()), (error) => error.name === 'AbortError')
  assert.equal(calls.prepare[0].signal.aborted, true)
})

test('debug logging is emitted only when debug is enabled', async () => {
  const enabled = makeCtx()
  const { lines } = await captureConsole('log', () => createGenerator(enabled.ctx, { debug: true })(makeSession()))
  assert.deepEqual(
    lines.map((args) => args[1]),
    ['route', 'context', 'finish'],
  )
  assert.equal(lines[0][0], '[composer-prefill]')

  const disabled = makeCtx()
  const quiet = await captureConsole('log', () => createGenerator(disabled.ctx, {})(makeSession()))
  assert.deepEqual(quiet.lines, [], 'no diagnostics without the debug switch')
})
