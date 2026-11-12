import z from '@deepseek-ai/schemastery'
import { registerRoute } from './lib/http.js'
import { createPredictions } from './lib/predictions.js'

/**
 * Host services this plugin cannot work without.
 *
 * `webServer` is used directly to register our exact route; `connection` runs
 * the host/origin fence and the owner check for that route.
 */
export const inject = ['sessions', 'connection', 'webServer', 'llm', 'agentDefaultModel']

/**
 * Tunables for composer predictions. The schema is projected into the Plugin
 * Manager's configuration form, so every field carries a user-facing
 * description and a safe default.
 */
export const Config = z.object({
  showPredictions: z
    .boolean()
    .default(true)
    .description(
      'Suggest the next message above the composer after an assistant turn. Each prediction costs one extra model call (roughly 2-4k input tokens); it never enters the transcript or the context window.',
    ),
  provider: z
    .string()
    .default('')
    .description('Provider route for predictions. Leave empty to follow the current session. `provider` and `model` must both be set to take effect.'),
  model: z
    .string()
    .default('')
    .description('Model id for predictions. Leave empty to follow the current session.'),
  maxContextTurns: z
    .natural()
    .min(1)
    .max(20)
    .default(4)
    .description('How many recent user/assistant turns are sent as prediction context.'),
  maxInputChars: z
    .natural()
    .min(500)
    .max(20000)
    .default(4000)
    .description('Upper bound on the characters of conversation context sent to the model.'),
  maxOutputTokens: z
    .natural()
    .min(16)
    .max(256)
    .default(64)
    .description('Upper bound on the prediction length in tokens.'),
  timeoutMs: z
    .natural()
    .min(500)
    .max(20000)
    .default(8000)
    .description('Give up on a prediction that takes longer than this.'),
  minIntervalMs: z
    .natural()
    .min(0)
    .max(60000)
    .default(1500)
    .description('Minimum gap between two prediction requests.'),
  debug: z.boolean().default(false).description('Emit prediction diagnostics to the Host log.'),
})

/**
 * Host half of the composer-prefill bundle.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx owning plugin context.
 * @param {unknown} config effective row configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const predictions = createPredictions(ctx, config)
  registerRoute(ctx, predictions.handle)
}
