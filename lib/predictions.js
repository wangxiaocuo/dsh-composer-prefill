/**
 * Prediction requests for one mounted Host plugin: caching, request coalescing,
 * throttling, the reroll path and the two RPC handlers.
 */

import { readConfig, readNumber } from './config.js'
import { createGenerator } from './generate.js'

/** Bounded per-session result cache; oldest entry is evicted first. */
const MAX_CACHE_ENTRIES = 32

/** Request modes understood by the endpoint. */
export const MODE_CACHED = 'cached'
export const MODE_REFRESH = 'refresh'

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
 * @param {{ generate?: (session: object, signal?: AbortSignal, context?: { attempt?: number }) => Promise<string | null>, entryId?: string | null }} [options]
 *   test seam for the model call, and the Loader entry id reported to the settings row.
 * @returns {{ handle: (payload: unknown, signal: AbortSignal | undefined) => Promise<object>, prefs: () => Promise<object> }} the RPC handlers.
 */
export function createPredictions(ctx, config, options = {}) {
  const generate = typeof options.generate === 'function' ? options.generate : createGenerator(ctx, config)
  const entryId = typeof options.entryId === 'string' ? options.entryId : null

  /** sessionId -> { seq, text } */
  const cache = new Map()
  /** sessionId -> Promise<string | null> */
  const inflight = new Map()
  /** sessionId -> timestamp of the last accepted request */
  const lastRequestAt = new Map()
  /** sessionId -> newest request token, so a superseded generation cannot write the cache */
  const requestTokens = new Map()
  /** sessionId -> { seq, attempt } so a reroll can ask the model for a different angle */
  const attempts = new Map()

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
  async function run(session, seq, signal) {
    const previous = attempts.get(session.id)
    const attempt = previous !== undefined && previous.seq === seq ? previous.attempt + 1 : 1
    attempts.set(session.id, { seq, attempt })
    try {
      return await generate(session, signal, { attempt })
    } catch (error) {
      console.warn('[composer-prefill] generation failed:', error)
      return null
    }
  }

  /**
   * Resolve one prediction.
   *
   * @param {string} sessionId target session.
   * @param {AbortSignal | undefined} signal caller cancellation.
   * @param {string} mode `cached` replays only, `refresh` forces a new generation,
   *   omission is the normal "reuse if fresh, else generate" path.
   * @returns {Promise<{ enabled: boolean, text: string | null, cached?: true }>} wire value.
   */
  async function predict(sessionId, signal, mode) {
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
    const refresh = mode === MODE_REFRESH
    if (!refresh) {
      const cached = cache.get(sessionId)
      if (cached !== undefined && cached.seq === seq) return { enabled: true, text: cached.text, cached: true }
      // Re-opening a session must never cost a model call: serve the cache or nothing.
      if (mode === MODE_CACHED) return { enabled: true, text: null }

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
    }

    // A reroll is an explicit user action: it skips the cache and the interval,
    // and it supersedes any generation already running for this session.
    lastRequestAt.set(sessionId, Date.now())
    const token = (requestTokens.get(sessionId) ?? 0) + 1
    requestTokens.set(sessionId, token)

    const promise = run(session, seq, signal)
      .then((text) => {
        if (requestTokens.get(sessionId) === token && typeof text === 'string' && text !== '') {
          remember(sessionId, seq, text)
        }
        return text
      })
      .finally(() => {
        if (inflight.get(sessionId) === promise) inflight.delete(sessionId)
      })
    inflight.set(sessionId, promise)

    const text = await promise
    debug('generated', { sessionId, seq, chars: typeof text === 'string' ? text.length : 0, mode: mode ?? 'generate' })
    return { enabled: true, text }
  }

  /**
   * Connection RPC entry point for predictions. Always returns the result
   * union, never throws.
   *
   * @param {unknown} payload request body.
   * @param {AbortSignal | undefined} signal request cancellation.
   * @returns {Promise<object>} result union.
   */
  async function handle(payload, signal) {
    // `typeof x === 'object'` narrows to the bare `object` type, which has no
    // index signature; the payload contract is validated field-by-field below.
    const sessionId =
      payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload).sessionId : undefined
    const mode =
      payload !== null && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload).mode : undefined
    if (typeof sessionId !== 'string' || sessionId === '') {
      return failure('composer-prefill/bad-request', 'predict expects { sessionId: string, mode?: "cached" | "refresh" }')
    }
    try {
      const value = await predict(sessionId, signal, typeof mode === 'string' ? mode : undefined)
      return { ok: true, value }
    } catch (error) {
      console.warn('[composer-prefill] prediction failed:', error)
      return { ok: true, value: { enabled: true, text: null } }
    }
  }

  /**
   * Report the effective configuration plus the Loader entry id the settings row
   * needs to address this plugin's config form.
   *
   * @returns {Promise<object>} result union.
   */
  async function prefs() {
    return {
      ok: true,
      value: {
        enabled: readConfig(config, 'showPredictions', true) === true,
        entryId,
      },
    }
  }

  return { handle, prefs }
}
