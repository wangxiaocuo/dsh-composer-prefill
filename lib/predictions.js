/**
 * Prediction requests for one mounted Host plugin: caching, request coalescing,
 * throttling and the Connection RPC entry point.
 */

import { readConfig, readNumber } from './config.js'
import { createGenerator } from './generate.js'

/** Bounded per-session result cache; oldest entry is evicted first. */
const MAX_CACHE_ENTRIES = 32

/**
 * Failure result in the Connection RPC result union. The generic channel hands
 * this object to the browser unchanged, so it must never throw.
 *
 * @param {string} code stable error code.
 * @param {string} message human-readable reason.
 * @returns {{ ok: false, error: { code: string, message: string, details: Record<string, never> } }} failure.
 */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Build the prediction policy bound to one plugin context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx owning plugin context.
 * @param {unknown} config effective row configuration.
 * @param {((session: object, signal?: AbortSignal) => Promise<string | null>) | undefined} generatorOverride
 *   test seam; defaults to the real one-shot model call.
 * @returns {{ handle: (payload: unknown, signal?: AbortSignal) => Promise<object> }} the RPC handler.
 */
export function createPredictions(ctx, config, generatorOverride) {
  const generate = typeof generatorOverride === 'function' ? generatorOverride : createGenerator(ctx, config)

  /** sessionId -> { seq, text } */
  const cache = new Map()
  /** sessionId -> Promise<string | null> */
  const inflight = new Map()
  /** sessionId -> timestamp of the last accepted request */
  const lastRequestAt = new Map()

  const debugEnabled = () => readConfig(config, 'debug', false) === true

  /**
   * @param {unknown[]} args diagnostic payload.
   * @returns {void}
   */
  function debug(...args) {
    if (debugEnabled()) console.log('[composer-prefill]', ...args)
  }

  /**
   * Store one result and keep the cache bounded.
   *
   * @param {string} sessionId owning session.
   * @param {number} seq session log offset the result was produced for.
   * @param {string} text predicted message.
   * @returns {void}
   */
  function remember(sessionId, seq, text) {
    cache.delete(sessionId)
    cache.set(sessionId, { seq, text })
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  /**
   * Run the generator, converting a failure into "no prediction" so the Client
   * never shows an error surface for a background nicety.
   *
   * @param {object} session live session.
   * @param {AbortSignal | undefined} signal caller cancellation.
   * @returns {Promise<string | null>} predicted text, or null.
   */
  async function run(session, signal) {
    try {
      return await generate(session, signal)
    } catch (error) {
      console.warn('[composer-prefill] generation failed:', error)
      return null
    }
  }

  /**
   * Resolve one prediction, reusing cache and coalescing concurrent requests.
   *
   * @param {string} sessionId target session.
   * @param {AbortSignal | undefined} signal caller cancellation.
   * @param {boolean} cachedOnly serve only a fresh cache entry, never generate.
   * @returns {Promise<{ enabled: boolean, text: string | null, cached?: true }>} wire value.
   */
  async function predict(sessionId, signal, cachedOnly) {
    if (readConfig(config, 'showPredictions', true) !== true) {
      debug('disabled', sessionId)
      return { enabled: false, text: null }
    }
    const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    if (session === undefined) {
      debug('no live session', sessionId)
      return { enabled: true, text: null }
    }

    const seq = session.seq
    const cached = cache.get(sessionId)
    if (cached !== undefined && cached.seq === seq) {
      debug('cache hit', sessionId, seq)
      return { enabled: true, text: cached.text, cached: true }
    }

    // Re-opening a session must never cost a model call: serve the cache or nothing.
    if (cachedOnly === true) {
      return { enabled: true, text: null }
    }

    const pending = inflight.get(sessionId)
    if (pending !== undefined) {
      debug('coalesced', sessionId)
      return { enabled: true, text: await pending }
    }

    const now = Date.now()
    const previous = lastRequestAt.get(sessionId)
    if (previous !== undefined && now - previous < readNumber(readConfig(config, 'minIntervalMs', 1500), 1500)) {
      debug('throttled', sessionId)
      return { enabled: true, text: null }
    }
    lastRequestAt.set(sessionId, now)

    const promise = run(session, signal)
      .then((text) => {
        if (typeof text === 'string' && text !== '') remember(sessionId, seq, text)
        return text
      })
      .finally(() => {
        if (inflight.get(sessionId) === promise) inflight.delete(sessionId)
      })
    inflight.set(sessionId, promise)

    const text = await promise
    debug('generated', { sessionId, seq, chars: typeof text === 'string' ? text.length : 0 })
    return { enabled: true, text }
  }

  /**
   * Connection RPC entry point. Always returns the result union, never throws.
   *
   * @param {unknown} payload request body.
   * @param {AbortSignal | undefined} signal request cancellation.
   * @returns {Promise<object>} result union.
   */
  async function handle(payload, signal) {
    const sessionId = payload !== null && typeof payload === 'object' ? payload.sessionId : undefined
    const mode = payload !== null && typeof payload === 'object' ? payload.mode : undefined
    if (typeof sessionId !== 'string' || sessionId === '') {
      return failure('composer-prefill/bad-request', 'predict expects { sessionId: string, mode?: "cached" }')
    }
    try {
      return { ok: true, value: await predict(sessionId, signal, mode === 'cached') }
    } catch (error) {
      console.warn('[composer-prefill] prediction failed:', error)
      return { ok: true, value: { enabled: true, text: null } }
    }
  }

  return { handle }
}
