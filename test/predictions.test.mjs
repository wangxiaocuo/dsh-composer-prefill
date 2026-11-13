/**
 * Unit tests for `lib/predictions.js`: cache, replay, coalescing, throttling,
 * the view advance credit, rerolls, attempt counting and both RPC handlers.
 *
 * The `generate` test seam keeps every case hermetic — no model is ever called.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MODE_CACHED, MODE_REFRESH, MODE_VIEW, createPredictions } from '../lib/predictions.js'

/**
 * @param {string} id session id.
 * @param {number} [seq] session log offset.
 * @returns {object} a stand-in live session.
 */
function makeSession(id, seq = 1) {
  return { id, seq }
}

/**
 * @param {object[]} sessions sessions served by `ctx.sessions.get`.
 * @returns {{ ctx: object, map: Map<string, object> }} harness.
 */
function makeCtx(sessions = [makeSession('s1')]) {
  const map = new Map(sessions.map((session) => [session.id, session]))
  const ctx = { sessions: { get: (id) => map.get(id) } }
  return { ctx, map }
}

/**
 * @returns {{ promise: Promise<unknown>, resolve: (value: unknown) => void, reject: (error: unknown) => void }} a manually settled promise.
 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/**
 * Run `fn` while capturing `console.warn`.
 *
 * @param {() => Promise<unknown>} fn body.
 * @returns {Promise<{ value: unknown, lines: unknown[][] }>} result plus captured argument lists.
 */
async function captureWarnings(fn) {
  const lines = []
  const original = console.warn
  console.warn = (...args) => {
    lines.push(args)
  }
  try {
    return { value: await fn(), lines }
  } finally {
    console.warn = original
  }
}

/**
 * @param {object} options generator seam and options.
 * @returns {{ predictions: { handle: Function, prefs: Function }, calls: object[] }} harness.
 */
function makePredictions(options = {}) {
  const calls = []
  const generate =
    options.generate ??
    ((session, _signal, context) => {
      calls.push({ sessionId: session.id, context })
      return Promise.resolve(`suggestion ${context.attempt}`)
    })
  const { ctx } = makeCtx(options.sessions ?? [makeSession('s1')])
  const predictions = createPredictions(ctx, { showPredictions: true, minIntervalMs: 0, ...options.config }, { generate, entryId: options.entryId })
  return { predictions, calls }
}

test('the handle rejects malformed payloads without generating', async () => {
  const { predictions, calls } = makePredictions()
  for (const payload of [undefined, null, {}, { sessionId: '' }, { sessionId: 42 }, { sessionId: null }]) {
    const result = await predictions.handle(payload, undefined)
    assert.equal(result.ok, false, `payload ${JSON.stringify(payload)}`)
    assert.equal(result.error.code, 'composer-prefill/bad-request')
    assert.match(result.error.message, /sessionId/)
  }
  assert.equal(calls.length, 0, 'a malformed request never reaches the generator')
})

test('the kill switch reports disabled and never generates', async () => {
  const { predictions, calls } = makePredictions({ config: { showPredictions: false } })
  const result = await predictions.handle({ sessionId: 's1' }, undefined)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { enabled: false, text: null })

  const prefs = await predictions.prefs()
  assert.deepEqual(prefs, { ok: true, value: { enabled: false, entryId: null } })
  assert.equal(calls.length, 0)
})

test('only an exact boolean true enables predictions', async () => {
  for (const showPredictions of [1, 'true', false]) {
    const { predictions, calls } = makePredictions({ config: { showPredictions } })
    const result = await predictions.handle({ sessionId: 's1' }, undefined)
    assert.deepEqual(result.value, { enabled: false, text: null }, `showPredictions ${String(showPredictions)}`)
    assert.equal(calls.length, 0)
  }

  // Cordis fills defaults before `apply`, so a nullish field means "not set"
  // and the documented default (enabled) applies.
  for (const showPredictions of [undefined, null]) {
    const { predictions } = makePredictions({ config: { showPredictions } })
    assert.deepEqual((await predictions.handle({ sessionId: 's1' }, undefined)).value, { enabled: true, text: 'suggestion 1' })
  }
})

test('a missing session yields no text and no call', async () => {
  const { ctx } = makeCtx([])
  const generate = () => {
    throw new Error('must not generate')
  }
  const predictions = createPredictions(ctx, { showPredictions: true }, { generate })
  const result = await predictions.handle({ sessionId: 'gone' }, undefined)
  assert.deepEqual(result.value, { enabled: true, text: null })

  const noSessionsService = createPredictions({}, { showPredictions: true }, { generate })
  assert.deepEqual((await noSessionsService.handle({ sessionId: 's1' }, undefined)).value, { enabled: true, text: null })
})

test('a fresh turn generates once and the same offset replays from cache', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const attempts = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (target, _signal, context) => {
      attempts.push(context.attempt)
      return Promise.resolve(`suggestion for turn ${target.seq}`)
    },
  })

  const first = await policy.handle({ sessionId: 's1' }, undefined)
  assert.deepEqual(first.value, { enabled: true, text: 'suggestion for turn 1' }, 'the first call is not a cache hit')

  const second = await policy.handle({ sessionId: 's1' }, undefined)
  assert.deepEqual(second.value, { enabled: true, text: 'suggestion for turn 1', cached: true })
  assert.equal(attempts.length, 1, 'the cache prevents a second model call')

  session.seq = 2
  const nextTurn = await policy.handle({ sessionId: 's1' }, undefined)
  assert.deepEqual(nextTurn.value, { enabled: true, text: 'suggestion for turn 2' })
  assert.equal(attempts.length, 2, 'a new session offset is a new generation')
})

test('mode "cached" replays only a cache entry from the same offset', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: () => {
      calls.push('generate')
      return Promise.resolve('warm suggestion')
    },
  })

  const cold = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.deepEqual(cold.value, { enabled: true, text: null }, 'a cold cache serves nothing')
  assert.equal(calls.length, 0, 'a cached lookup never calls the model')

  await policy.handle({ sessionId: 's1' }, undefined)
  const warm = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.deepEqual(warm.value, { enabled: true, text: 'warm suggestion', cached: true })
  assert.equal(calls.length, 1, 'the replay costs no model call')

  session.seq = 2
  const stale = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.deepEqual(stale.value, { enabled: true, text: null }, 'a suggestion from an older turn is not replayed')
  assert.equal(calls.length, 1, 'a stale lookup still costs no model call')
})

test('mode "view" on a session never asked about serves nothing and costs no call', async () => {
  const { predictions, calls } = makePredictions()
  const result = await predictions.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(result.value, { enabled: true, text: null }, 'a first view has nothing to show')
  assert.equal(calls.length, 0, 'a first view never reaches the generator')
})

test('mode "view" generates once the session advanced past the last ask', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (target) => {
      calls.push(target.seq)
      return Promise.resolve(`suggestion for turn ${target.seq}`)
    },
  })

  // The browser's mount ask records the offset without generating anything.
  const mount = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.deepEqual(mount.value, { enabled: true, text: null })
  assert.equal(calls.length, 0, 'the mount ask costs no model call')

  session.seq = 3
  const viewed = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(viewed.value, { enabled: true, text: 'suggestion for turn 3' }, 'a turn finished while hidden is predicted')
  assert.deepEqual(calls, [3], 'the view generated exactly once, for the new offset')
})

test('a second view at the same offset replays the cache', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: () => {
      calls.push('generate')
      return Promise.resolve('warm suggestion')
    },
  })

  await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  session.seq = 2
  assert.equal((await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)).value.text, 'warm suggestion')
  assert.equal(calls.length, 1)

  const replayed = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(replayed.value, { enabled: true, text: 'warm suggestion', cached: true })
  assert.equal(calls.length, 1, 'the second view costs no model call')
})

test('mode "view" without a new turn returns nothing and costs no call', async () => {
  const { predictions, calls } = makePredictions()
  // The mount ask records the current offset; the session does not advance.
  await predictions.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  const viewed = await predictions.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(viewed.value, { enabled: true, text: null }, 'no new turn since the last ask')
  assert.equal(calls.length, 0, 'an idle view never reaches the generator')
})

test('an aborted view does not consume the advance and the next view retries', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  let controller
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (_target, signal) => {
      calls.push({ abortedAtCall: signal?.aborted === true })
      // The browser switched away while the model call was still running.
      if (calls.length === 1) controller.abort()
      return Promise.resolve(calls.length === 1 ? null : 'retried suggestion')
    },
  })

  // The mount ask records the offset without generating anything.
  await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  session.seq = 2
  controller = new AbortController()
  const aborted = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, controller.signal)
  assert.deepEqual(aborted.value, { enabled: true, text: null }, 'the interrupted view shows nothing')
  assert.deepEqual(calls, [{ abortedAtCall: false }], 'the interrupted view did start one generation')

  const retried = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, new AbortController().signal)
  assert.deepEqual(retried.value, { enabled: true, text: 'retried suggestion' }, 'the next view retries the fill')
  assert.deepEqual(calls, [{ abortedAtCall: false }, { abortedAtCall: false }], 'the retry generated exactly once')

  const replayed = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, new AbortController().signal)
  assert.deepEqual(replayed.value, { enabled: true, text: 'retried suggestion', cached: true })
  assert.equal(calls.length, 2, 'the successful retry is now served from the cache')
})

test('mode "view" is throttled inside the minimum interval and retried after it', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 100 }, {
    generate: (target) => {
      calls.push(target.seq)
      return Promise.resolve(`suggestion for turn ${target.seq}`)
    },
  })

  assert.equal((await policy.handle({ sessionId: 's1' }, undefined)).value.text, 'suggestion for turn 1')
  session.seq = 2
  const throttled = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(throttled.value, { enabled: true, text: null }, 'a view inside the interval is dropped')
  assert.deepEqual(calls, [1], 'the throttled view costs no model call')

  // A drop must not consume the advance credit: once the interval passes the
  // same switch-back retries for the new offset.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const retried = await policy.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(retried.value, { enabled: true, text: 'suggestion for turn 2' }, 'the retry fills the new turn')
  assert.deepEqual(calls, [1, 2], 'the retry generated exactly once')
})

test('mode "view" is free after a turn-end generation at the same offset', async () => {
  const { predictions, calls } = makePredictions()
  assert.equal((await predictions.handle({ sessionId: 's1' }, undefined)).value.text, 'suggestion 1')
  const viewed = await predictions.handle({ sessionId: 's1', mode: MODE_VIEW }, undefined)
  assert.deepEqual(viewed.value, { enabled: true, text: 'suggestion 1', cached: true })
  assert.equal(calls.length, 1, 'the view replays the turn-end result instead of generating')
})

test('concurrent requests coalesce onto one generation', async () => {
  const gate = deferred()
  const calls = []
  const { ctx } = makeCtx([makeSession('s1', 1)])
  const policy = createPredictions(ctx, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (session, signal, context) => {
      calls.push({ sessionId: session.id, signal, context })
      return gate.promise
    },
  })

  const first = policy.handle({ sessionId: 's1' }, undefined)
  const second = policy.handle({ sessionId: 's1' }, undefined)
  assert.equal(calls.length, 1, 'the second request joins the in-flight generation')

  gate.resolve('shared suggestion')
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.value.text, 'shared suggestion')
  assert.equal(secondResult.value.text, 'shared suggestion')
  assert.equal(calls.length, 1, 'exactly one model call')

  // The in-flight entry is cleaned up, so the next turn still generates.
  const third = await policy.handle({ sessionId: 's1', mode: MODE_REFRESH }, undefined)
  assert.equal(calls.length, 2)
  assert.equal(third.value.text, 'shared suggestion')
})

test('the minimum interval throttles a new turn but mode "refresh" ignores it', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  const generate = () => {
    calls.push('generate')
    return Promise.resolve('suggestion')
  }
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true }, { generate })

  assert.equal((await policy.handle({ sessionId: 's1' }, undefined)).value.text, 'suggestion')
  session.seq = 2
  assert.deepEqual((await policy.handle({ sessionId: 's1' }, undefined)).value, { enabled: true, text: null }, 'inside interval')
  assert.equal(calls.length, 1, 'the throttled request costs no model call')

  assert.equal((await policy.handle({ sessionId: 's1', mode: MODE_REFRESH }, undefined)).value.text, 'suggestion')
  assert.equal(calls.length, 2, 'a reroll bypasses the interval')
})

test('a configured minIntervalMs of zero allows back-to-back generations', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const calls = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: () => {
      calls.push('generate')
      return Promise.resolve('suggestion')
    },
  })

  await policy.handle({ sessionId: 's1' }, undefined)
  session.seq = 2
  assert.equal((await policy.handle({ sessionId: 's1' }, undefined)).value.text, 'suggestion')
  assert.equal(calls.length, 2)
})

test('mode "refresh" bypasses the cache, replaces it and increments the attempt', async () => {
  const session = makeSession('s1', 1)
  const map = new Map([['s1', session]])
  const texts = ['first', 'second', 'third']
  const attempts = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (_session, _signal, context) => {
      attempts.push(context.attempt)
      return Promise.resolve(texts[context.attempt - 1])
    },
  })

  assert.deepEqual((await policy.handle({ sessionId: 's1' }, undefined)).value, { enabled: true, text: 'first' })
  assert.deepEqual((await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)).value, {
    enabled: true,
    text: 'first',
    cached: true,
  })

  const rerolled = await policy.handle({ sessionId: 's1', mode: MODE_REFRESH }, undefined)
  assert.deepEqual(rerolled.value, { enabled: true, text: 'second' }, 'a refresh is never a cache hit')

  const replaced = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.deepEqual(replaced.value, { enabled: true, text: 'second', cached: true }, 'the refresh replaced the cache entry')

  await policy.handle({ sessionId: 's1', mode: MODE_REFRESH }, undefined)
  assert.deepEqual(attempts, [1, 2, 3])

  session.seq = 2
  await policy.handle({ sessionId: 's1' }, undefined)
  assert.deepEqual(attempts, [1, 2, 3, 1], 'a new turn resets the attempt counter')
})

test('a superseded generation cannot overwrite the newer cache entry', async () => {
  const gates = []
  const policy = createPredictions({ sessions: { get: () => makeSession('s1', 1) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: () => {
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    },
  })

  const slow = policy.handle({ sessionId: 's1' }, undefined)
  assert.equal(gates.length, 1, 'the first generation started')

  const reroll = policy.handle({ sessionId: 's1', mode: MODE_REFRESH }, undefined)
  assert.equal(gates.length, 2, 'the reroll supersedes it with a second generation')

  gates[1].resolve('second')
  assert.equal((await reroll).value.text, 'second')
  gates[0].resolve('first')
  assert.equal((await slow).value.text, 'first', 'the superseded request still gets its own answer')

  const replayed = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.equal(replayed.value.text, 'second', 'only the newest generation is cached')
})

test('a failing generator degrades to no suggestion and is retried next time', async () => {
  let calls = 0
  const policy = createPredictions({ sessions: { get: () => makeSession('s1', 1) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: () => {
      calls += 1
      return Promise.reject(new Error('boom'))
    },
  })

  const result = await captureWarnings(() => policy.handle({ sessionId: 's1' }, undefined))
  assert.equal(result.value.ok, true, 'a failed generation is a success union with no text')
  assert.deepEqual(result.value.value, { enabled: true, text: null })
  assert.equal(result.lines.length, 1, 'the failure is logged for the Host log')
  assert.equal(calls, 1)

  await policy.handle({ sessionId: 's1' }, undefined)
  assert.equal(calls, 2, 'a failure is not cached')
})

test('null and empty generator results are not cached', async () => {
  let calls = 0
  let result = null
  const policy = createPredictions({ sessions: { get: () => makeSession('s1', 1) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: () => {
      calls += 1
      return Promise.resolve(result)
    },
  })

  result = null
  assert.deepEqual((await policy.handle({ sessionId: 's1' }, undefined)).value, { enabled: true, text: null })
  assert.deepEqual((await policy.handle({ sessionId: 's1' }, undefined)).value, { enabled: true, text: null })
  assert.equal(calls, 2, 'a null result is not cached')

  result = ''
  assert.equal((await policy.handle({ sessionId: 's1' }, undefined)).value.text, '')
  await policy.handle({ sessionId: 's1' }, undefined)
  assert.equal(calls, 4, 'an empty result is not cached either')
})

test('the cache is bounded and evicts the oldest session first', async () => {
  const sessions = Array.from({ length: 33 }, (_value, index) => makeSession(`s${index}`, 1))
  const map = new Map(sessions.map((session) => [session.id, session]))
  const calls = []
  const policy = createPredictions({ sessions: { get: (id) => map.get(id) } }, { showPredictions: true, minIntervalMs: 0 }, {
    generate: (session) => {
      calls.push(session.id)
      return Promise.resolve(`text ${session.id}`)
    },
  })

  for (const session of sessions) await policy.handle({ sessionId: session.id }, undefined)
  assert.equal(calls.length, 33)

  const evicted = await policy.handle({ sessionId: 's0', mode: MODE_CACHED }, undefined)
  assert.deepEqual(evicted.value, { enabled: true, text: null }, 'the oldest session was evicted')
  const kept = await policy.handle({ sessionId: 's1', mode: MODE_CACHED }, undefined)
  assert.deepEqual(kept.value, { enabled: true, text: 'text s1', cached: true })
  assert.equal(calls.length, 33, 'cache lookups cost no model call')
})

test('prefs reports the effective switch and the Loader entry id', async () => {
  const enabled = makePredictions({ entryId: 'include:composer-prefill' })
  assert.deepEqual(await enabled.predictions.prefs(), {
    ok: true,
    value: { enabled: true, entryId: 'include:composer-prefill' },
  })

  const noEntry = makePredictions({ entryId: undefined })
  assert.deepEqual(await noEntry.predictions.prefs(), { ok: true, value: { enabled: true, entryId: null } })

  const badEntry = makePredictions({ entryId: 42 })
  assert.deepEqual(await badEntry.predictions.prefs(), { ok: true, value: { enabled: true, entryId: null } })
})

test('a non-string mode is treated as the normal generate path', async () => {
  const { predictions, calls } = makePredictions()
  const result = await predictions.handle({ sessionId: 's1', mode: 5 }, undefined)
  assert.deepEqual(result.value, { enabled: true, text: 'suggestion 1' })
  assert.equal(calls.length, 1)
})

test('an unexpected lookup failure still returns the result union', async () => {
  const ctx = {
    sessions: {
      get() {
        throw new Error('session store unavailable')
      },
    },
  }
  const generate = () => Promise.resolve('never used')
  const policy = createPredictions(ctx, { showPredictions: true }, { generate })
  const result = await captureWarnings(() => policy.handle({ sessionId: 's1' }, undefined))
  assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.value, { enabled: true, text: null })
  assert.equal(result.lines.length, 1)
})

test('the default generator seam wires the real model call', async () => {
  const session = {
    id: 's1',
    seq: 1,
    requestHeader: () => ({ config: { provider: 'route-provider', model: 'route-model' } }),
    deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  const prepared = []
  const ctx = {
    sessions: { get: () => session },
    llm: {
      async prepareCall(config) {
        prepared.push(config)
        return {
          config,
          stream: async function* stream() {
            yield { type: 'text-delta', text: 'from the model' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
  const policy = createPredictions(ctx, { showPredictions: true, minIntervalMs: 0, maxOutputTokens: 24 }, { entryId: 'entry' })
  const result = await policy.handle({ sessionId: 's1' }, undefined)
  assert.deepEqual(result.value, { enabled: true, text: 'from the model' })
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].provider, 'route-provider')
  assert.equal(prepared[0].model, 'route-model')
  assert.equal(prepared[0].maxTokens, 24)
})

test('debug diagnostics are emitted only when debug is enabled', async () => {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args)
  }
  try {
    const enabled = makePredictions({ config: { debug: true } })
    await enabled.predictions.handle({ sessionId: 's1' }, undefined)
    assert.equal(lines.length, 1, 'exactly one "generated" diagnostic')
    assert.equal(lines[0][1], 'generated')

    lines.length = 0
    const disabled = makePredictions()
    await disabled.predictions.handle({ sessionId: 's1' }, undefined)
    assert.deepEqual(lines, [])
  } finally {
    console.log = original
  }
})
