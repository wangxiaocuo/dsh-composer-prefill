import z from '@deepseek-ai/schemastery'
import { registerApi } from './lib/http.js'
import { createPredictions } from './lib/predictions.js'

/**
 * Host services this plugin cannot work without.
 *
 * `webServer` is used directly to register our exact routes; `connection` runs
 * the host/origin fence and the owner check for them.
 */
export const inject = ['sessions', 'connection', 'webServer', 'llm', 'agentDefaultModel']

/**
 * Tunables for composer predictions. The schema is projected into the Plugin
 * Manager's configuration form, so every field carries a user-facing
 * description and a safe default.
 */
export const Config = z.object({
  // `.volatile()` is what makes this field part of the live settings document:
  // `@deepseek-ai/dsh-settings` only exposes a namespace when its form has a
  // volatile field, and the Settings → General row writes through that
  // namespace. Without it the switch looks functional (optimistic state) but
  // every write is rejected and the choice never persists.
  showPredictions: z
    .boolean()
    .volatile()
    .default(true)
    .description(
      'Suggest the next message above the composer after an assistant turn. Each prediction costs one extra model call (roughly 3-5k input tokens); it never enters the transcript or the context window.',
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
  includeToolActivity: z
    .boolean()
    .default(true)
    .description(
      'Include the tool names, short targets and outcomes from the assistant\'s last turn, so the prediction can name the file or command it just worked on. No tool output is sent.',
    ),
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
    .default(96)
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
  // The settings row addresses this plugin's config form by its Loader entry id.
  const entryId = typeof ctx.fiber?.entry?.options?.id === 'string' ? ctx.fiber.entry.options.id : null
  const predictions = createPredictions(ctx, config, { entryId })
  registerApi(ctx, { predict: predictions.handle, prefs: predictions.prefs })
}
