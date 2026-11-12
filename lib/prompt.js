/**
 * Prompt building and output hygiene for one prediction.
 *
 * The system prompt lives in `prompt.txt` next to the bundle and is re-read when
 * its modification time changes, so tuning it never needs a Host restart.
 */

import { readFileSync, statSync } from 'node:fs'

/** Used when `prompt.txt` is missing or empty. */
export const FALLBACK_SYSTEM_PROMPT =
  'You predict the next message a developer will type in their AI coding assistant. ' +
  'Write the single next user message, in the conversation language, as one line of at most 100 characters. ' +
  'Output only that message: no quotes, no markdown, no prefix, no explanation. ' +
  'If no next message is plausible, output exactly: NONE'

/** Longest single message kept from the conversation tail. */
const MAX_MESSAGE_CHARS = 1500

/** Prompt file resolved against this module, not the working directory. */
const PROMPT_URL = new URL('../prompt.txt', import.meta.url)

/** Last successful prompt read: `{ mtimeMs, text }`. */
let promptCache = { mtimeMs: -1, text: FALLBACK_SYSTEM_PROMPT }

/**
 * Read the system prompt, refreshing it when the file changed on disk.
 *
 * @returns {string} the system prompt to send.
 */
export function loadSystemPrompt() {
  try {
    const stat = statSync(PROMPT_URL)
    if (stat.mtimeMs !== promptCache.mtimeMs) {
      const text = readFileSync(PROMPT_URL, 'utf8').trim()
      promptCache = { mtimeMs: stat.mtimeMs, text: text === '' ? FALLBACK_SYSTEM_PROMPT : text }
    }
    return promptCache.text
  } catch {
    return FALLBACK_SYSTEM_PROMPT
  }
}

/**
 * Concatenate the text blocks of one message, ignoring tool calls, reasoning,
 * images, files and anything else the model should not re-read here.
 *
 * @param {{ content?: unknown }} message model-visible message.
 * @returns {string} plain text, capped at {@link MAX_MESSAGE_CHARS}.
 */
function messageText(message) {
  const blocks = message !== null && typeof message === 'object' ? message.content : undefined
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n').trim()
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
}

/**
 * Take the recent user/assistant text turns that fit the budget.
 *
 * @param {readonly unknown[]} messages model-visible surface, oldest first.
 * @param {number} maxTurns how many recent turns (user+assistant pairs) to keep.
 * @param {number} maxInputChars character budget for the whole payload.
 * @returns {Array<{ role: 'user' | 'assistant', text: string }>} the tail.
 */
export function selectTurns(messages, maxTurns, maxInputChars) {
  if (!Array.isArray(messages) || maxTurns <= 0 || maxInputChars <= 0) return []
  const turns = []
  for (const message of messages) {
    const role = message !== null && typeof message === 'object' ? message.role : undefined
    if (role !== 'user' && role !== 'assistant') continue
    const text = messageText(message)
    if (text === '') continue
    turns.push({ role, text })
  }

  // One turn is a user message plus the assistant reply that follows it.
  const window = turns.slice(-maxTurns * 2)
  let total = window.reduce((sum, turn) => sum + turn.text.length, 0)
  while (window.length > 1 && total > maxInputChars) {
    total -= window[0].text.length
    window.shift()
  }
  return window
}

/**
 * Turn raw model output into a message the user could plausibly send.
 *
 * @param {unknown} raw model output.
 * @param {number} maxChars hard cap on the returned length.
 * @returns {string | null} the prediction, or null when nothing usable came back.
 */
export function sanitizePrediction(raw, maxChars) {
  if (typeof raw !== 'string') return null
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstLine === undefined) return null

  let text = firstLine
    .replace(/^[-*•]\s+/, '')
    .replace(/^["'`“”‘’]+/, '')
    .replace(/["'`“”‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^<?none>?[.!]?$/i.test(text)) return null
  if (text.length < 2) return null
  if (text.length > maxChars) text = text.slice(0, maxChars).trim()
  return text === '' ? null : text
}
