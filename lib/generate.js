/**
 * The one-shot model call behind a prediction.
 *
 * A bare `ctx.llm` call appends no session event, so the text never enters the
 * transcript, the token meter or the context window — but the provider bills it.
 */

import { readConfig, readNumber, readString } from './config.js'
import { loadSystemPrompt, sanitizePrediction, selectTurns } from './prompt.js'

/** Hard cap on the prediction handed back to the Client. */
const MAX_PREDICTION_CHARS = 200

/**
 * @param {unknown} config effective row configuration.
 * @param {unknown[]} args diagnostic payload.
 * @returns {void}
 */
function log(config, ...args) {
  if (readConfig(config, 'debug', false) === true) console.log('[composer-prefill]', ...args)
}

/**
 * Resolve the model route: an explicit pin, else the session's own route, else
 * the app default. Predictions never silently cross providers.
 *
 * @param {object} ctx plugin context.
 * @param {unknown} config effective row configuration.
 * @param {{ requestHeader?: () => ({ config?: { provider?: string, model?: string } } | undefined) }} session live session.
 * @returns {{ provider: string, model: string } | undefined} the route, or undefined when none is usable.
 */
function resolveRoute(ctx, config, session) {
  const pinnedProvider = readString(readConfig(config, 'provider', ''), '').trim()
  const pinnedModel = readString(readConfig(config, 'model', ''), '').trim()
  if (pinnedProvider !== '' && pinnedModel !== '') return { provider: pinnedProvider, model: pinnedModel }

  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const fromHeader = header === null || header === undefined ? undefined : header.config
  if (fromHeader !== undefined && typeof fromHeader.provider === 'string' && typeof fromHeader.model === 'string') {
    return { provider: fromHeader.provider, model: fromHeader.model }
  }

  const fallback = typeof ctx.agentDefaultModel?.currentSelection === 'function' ? ctx.agentDefaultModel.currentSelection() : undefined
  if (fallback !== undefined && fallback !== null && typeof fallback.provider === 'string' && typeof fallback.model === 'string') {
    return { provider: fallback.provider, model: fallback.model }
  }
  return undefined
}

/**
 * Build the generator bound to one plugin context.
 *
 * @param {object} ctx plugin context with `llm`, `agentDefaultModel` and `sessions`.
 * @param {unknown} config effective row configuration.
 * @returns {(session: object, signal?: AbortSignal, context?: { attempt?: number }) => Promise<string | null>} generator.
 *   The third argument carries the reroll attempt number; it only feeds the
 *   prompt payload and never changes the request controls.
 */
export function createGenerator(ctx, config) {
  return async function generate(session, signal, context = {}) {
    const route = resolveRoute(ctx, config, session)
    log(config, 'route', route)
    if (route === undefined) return null

    const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    const turns = selectTurns(
      messages,
      readNumber(readConfig(config, 'maxContextTurns', 4), 4),
      readNumber(readConfig(config, 'maxInputChars', 4000), 4000),
    )
    log(config, 'context', { turns: turns.length, chars: turns.reduce((sum, turn) => sum + turn.text.length, 0) })
    if (turns.length === 0) return null

    const timeoutMs = readNumber(readConfig(config, 'timeoutMs', 8000), 8000)
    const maxTokens = readNumber(readConfig(config, 'maxOutputTokens', 64), 64)
    const deadline = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])

    // Every request control is chosen HERE: the prepared call snapshots this
    // config and refuses to dispatch when the stream options disagree.
    const call = await ctx.llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, combined, (controls, model) => ({
      ...controls,
      reasoningEffort: model.reasoning?.efforts?.[0]?.id,
    }))

    let text = ''
    let finishKind = 'error'
    for await (const chunk of call.stream({
      ...call.config,
      system: loadSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: JSON.stringify({ turns, attempt: context.attempt ?? 1 }) }],
        },
      ],
      signal: combined,
      purpose: 'composer-prefill',
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') finishKind = chunk.reason?.kind ?? 'error'
    }

    log(config, 'finish', { finishKind, rawChars: text.length })
    // `max-tokens` still carries a usable first line; aborted/error do not.
    if (finishKind !== 'stop' && finishKind !== 'max-tokens') return null
    const prediction = sanitizePrediction(text, MAX_PREDICTION_CHARS)
    return prediction
  }
}
