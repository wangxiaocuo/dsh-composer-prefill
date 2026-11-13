/**
 * Prompt payload construction and output hygiene for one prediction.
 *
 * The system prompt lives in `prompt.txt` next to the bundle and is re-read when
 * its modification time changes, so tuning it never needs a Host restart.
 *
 * The payload is deliberately small but grounded: the user's original task, the
 * recent human/assistant turns, the tool calls the assistant just made, and the
 * language to answer in. DSH injects runtime context, skill catalogs and time
 * snapshots as `role: "user"` messages; those must never reach the predictor or
 * they drown out the conversation tail.
 */

import { readFileSync, statSync } from 'node:fs'

/** Used when `prompt.txt` is missing or empty. */
export const FALLBACK_SYSTEM_PROMPT =
  'You predict the next message the user will type in a chat with an AI coding agent. ' +
  'Use the JSON input: task, language, recent turns, and the tool calls the assistant just made. ' +
  'Answer the assistant\'s question, react to its result, or take the concrete next step it named. ' +
  'Stay on the user\'s thread, match their voice, never invent a new goal, and never repeat the assistant. ' +
  'Write one line in the conversation language, at most 100 characters, and output only that message. ' +
  'Output exactly NONE when the last turn is not a completed assistant reply or there is no real task.'

/** Longest single message kept from the conversation tail. */
const MAX_MESSAGE_CHARS = 1500

/** Longest original-task excerpt kept for a long session. */
const MAX_TASK_CHARS = 400

/** Tool calls kept from the assistant's last turn after de-duplication. */
const MAX_ACTIONS = 4

/** Longest single tool target kept in one action entry. */
const MAX_TARGET_CHARS = 100

/** Marker between the retained head and tail of one clipped message. */
const CLIP_MARKER = '\n…\n'

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
 * Keep both ends of a long text: the opening states the goal and the ending
 * carries the decision, question or next step the predictor must react to.
 *
 * @param {string} text source text.
 * @param {number} limit maximum returned length.
 * @returns {string} the clipped text.
 */
function clipText(text, limit) {
  if (text.length <= limit) return text
  if (limit <= CLIP_MARKER.length + 8) return text.slice(0, limit)
  const head = Math.floor((limit - CLIP_MARKER.length) * 0.25)
  const tail = limit - CLIP_MARKER.length - head
  return `${text.slice(0, head).trimEnd()}${CLIP_MARKER}${text.slice(-tail).trimStart()}`
}

/**
 * Flatten one short value onto a single line.
 *
 * @param {unknown} value candidate.
 * @param {number} limit maximum returned length.
 * @returns {string} one trimmed line, possibly truncated.
 */
function oneLine(value, limit) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * Sources that describe the Harness, not the human: runtime context, the skill
 * catalog, time snapshots and job notices all arrive as `role: "user"`. They are
 * long, repetitive and irrelevant to what the user will type next. Other
 * non-`user` sources (a scheduled prompt, a plugin input) stay in the tail.
 */
const INJECTED_USER_KINDS = new Set([
  'runtime-context',
  'skill-catalog',
  'time-context',
  'system-prompt',
  'tool-jobs',
  'dsh-session-title-llm',
])

/**
 * Whether a user-role message is Harness-injected context rather than something
 * the human typed.
 *
 * @param {{ source?: unknown }} message a derived message.
 * @returns {boolean} true when the message must be ignored.
 */
function isInjectedUser(message) {
  const source = message.source
  if (source === null || typeof source !== 'object') return false
  const kind = /** @type {{ kind?: unknown }} */ (source).kind
  return typeof kind === 'string' && INJECTED_USER_KINDS.has(kind)
}

/**
 * Concatenate the text blocks of one message, ignoring tool calls, reasoning,
 * images, files and anything else the model should not re-read here.
 *
 * @param {{ content?: unknown, source?: unknown }} message model-visible message.
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
  return clipText(text, MAX_MESSAGE_CHARS)
}

/**
 * Take the recent human/assistant text turns that fit the budget.
 *
 * The last entry must be an assistant reply: a trailing user message or a
 * tool-only step means the turn is not ready to be predicted from. The window
 * always starts at a user message so the assistant's reply keeps its prompt.
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
    if (role === 'user' && isInjectedUser(message)) continue
    const text = messageText(message)
    if (text === '') continue
    turns.push({ role, text })
  }
  if (turns.length === 0 || turns[turns.length - 1].role !== 'assistant') return []

  const window = turns.slice(-maxTurns * 2)
  while (window.length > 0 && window[0].role !== 'user') window.shift()
  if (window.length < 2) return []

  let total = window.reduce((sum, turn) => sum + turn.text.length, 0)
  while (window.length > 2 && total > maxInputChars) {
    total -= window[0].text.length
    window.shift()
    // A user message and its reply are one turn: never leave an orphan reply.
    if (window.length > 0 && window[0].role !== 'user') {
      total -= window[0].text.length
      window.shift()
    }
  }
  return window
}

/**
 * Drop the setup every shell command shares so the action list reads as
 * `pnpm test`, not `sleep 40; cd /Users/... && pnpm test 2>&1 | tail -5`.
 *
 * @param {string} command raw command line.
 * @param {string} cwd session working directory, when known.
 * @returns {string} the leading meaningful command, single line.
 */
function cleanCommand(command, cwd) {
  let text = command.trim()
  if (cwd !== '') text = text.split(cwd).join('.')
  text = text.replace(/^(?:(?:cd\s+[^;&|]+|sleep\s+\d+(?:\.\d+)?|export\s+[^;&|]+)\s*(?:&&|;)\s*)+/g, '')
  if (/\b(?:python3?|node)\s+-\s*<<-?\s*['"]?\w+/.test(text)) return text.slice(0, MAX_TARGET_CHARS)
  const first = text.split(/\s*(?:&&|;|\|\|?)\s*/)[0]
  const cleaned = first.replace(/\s+\d?>&\d+$/, '').replace(/\s+>\s*\S+.*$/, '')
  return oneLine(cleaned === '' ? text : cleaned, MAX_TARGET_CHARS)
}

/**
 * Shorten a path by the session's working directory.
 *
 * @param {string} value raw path.
 * @param {string} cwd session working directory, when known.
 * @returns {string} one short line.
 */
function cleanPath(value, cwd) {
  const inside = cwd !== '' && (value === cwd || value.startsWith(`${cwd}/`))
  const text = inside ? `.${value.slice(cwd.length)}` : value
  return oneLine(text, MAX_TARGET_CHARS)
}

/**
 * Pick the most useful string out of one tool-call argument object.
 *
 * @param {unknown} raw serialized tool arguments.
 * @param {string} [cwd] session working directory, when known.
 * @returns {string} a short, single-line target.
 */
function toolTarget(raw, cwd = '') {
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']) {
        const value = /** @type {Record<string, unknown>} */ (parsed)[key]
        if (typeof value !== 'string' || value === '') continue
        if (key === 'command' || key === 'cmd') return cleanCommand(value, cwd)
        if (key === 'file_path' || key === 'path') return cleanPath(value, cwd)
        return oneLine(value, MAX_TARGET_CHARS)
      }
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return oneLine(raw, MAX_TARGET_CHARS)
}

/**
 * Summarize the tool calls the assistant made after the latest user message.
 * Only the tool name, a short target and the outcome are kept — never output.
 * Repeated calls collapse to one entry so a polling loop cannot crowd out the
 * meaningful file or command.
 *
 * @param {readonly unknown[]} messages model-visible surface, oldest first.
 * @param {number} maxActions how many recent calls to keep.
 * @param {string} [cwd] session working directory, when known.
 * @returns {Array<{ name: string, target: string, status: 'ok' | 'error' }>} actions.
 */
export function extractActions(messages, maxActions = MAX_ACTIONS, cwd = '') {
  if (!Array.isArray(messages) || maxActions <= 0) return []
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== null && typeof message === 'object' && message.role === 'user' && !isInjectedUser(message)) {
      start = index + 1
      break
    }
  }

  const actions = []
  const byKey = new Map()
  const byCallId = new Map()
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
        const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
        const target = toolTarget(block.arguments, cwd)
        const key = `${name}\u0000${target}`
        let action = byKey.get(key)
        if (action === undefined) {
          action = { name, target, status: /** @type {'ok' | 'error'} */ ('ok') }
          byKey.set(key, action)
          actions.push(action)
        }
        if (typeof block.id === 'string' && block.id !== '') byCallId.set(block.id, action)
      }
    } else if (message.role === 'tool') {
      const action = typeof message.toolCallId === 'string' ? byCallId.get(message.toolCallId) : undefined
      if (action !== undefined && message.isError === true) action.status = 'error'
    }
  }
  return actions.slice(-maxActions)
}

/** Script detectors, most specific first: kana wins over CJK, Hangul over CJK.
 * @type {ReadonlyArray<readonly [string, RegExp]>}
 */
const SCRIPTS = [
  ['Japanese', /[\u3040-\u30ff]/],
  ['Korean', /[\uac00-\ud7af]/],
  ['Chinese', /[\u4e00-\u9fff]/],
  ['Russian', /[\u0400-\u04ff]/],
  ['Arabic', /[\u0600-\u06ff]/],
  ['Hindi', /[\u0900-\u097f]/],
  ['Thai', /[\u0e00-\u0e7f]/],
  ['Hebrew', /[\u0590-\u05ff]/],
]

/**
 * Name the language of the latest user messages. Only the script is detected;
 * the model still mirrors register and Simplified/Traditional form from turns.
 *
 * @param {ReadonlyArray<{ role: 'user' | 'assistant', text: string }>} turns selected turns.
 * @returns {string | null} language name, or null when it cannot be named.
 */
export function detectLanguage(turns) {
  const sample = turns
    .filter((turn) => turn.role === 'user')
    .slice(-3)
    .map((turn) => turn.text)
    .join('\n')
  if (sample === '') return null
  for (const [name, pattern] of SCRIPTS) {
    if (pattern.test(sample)) return name
  }
  // Latin script without diacritics is overwhelmingly English in coding chats.
  if (/[A-Za-z]/.test(sample) && !/[À-ÖØ-öø-ÿ]/.test(sample)) return 'English'
  return null
}

/**
 * First human user message, used as the task anchor on long sessions.
 *
 * @param {readonly unknown[]} messages model-visible surface, oldest first.
 * @returns {string} clipped task text, or an empty string.
 */
function taskAnchor(messages) {
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || /** @type {{ role?: unknown }} */ (message).role !== 'user') continue
    if (isInjectedUser(/** @type {{ source?: unknown }} */ (message))) continue
    const text = messageText(message)
    if (text !== '') return clipText(text, MAX_TASK_CHARS)
  }
  return ''
}

/**
 * Build the JSON payload one prediction call sends.
 *
 * @param {readonly unknown[]} messages model-visible surface, oldest first.
 * @param {{
 *   maxTurns?: number,
 *   maxInputChars?: number,
 *   maxActions?: number,
 *   includeToolActivity?: boolean,
 *   attempt?: number,
 *   previous?: string,
 *   cwd?: string,
 * }} [options] request options.
 * @returns {{
 *   task?: string,
 *   language?: string,
 *   turns: Array<{ role: 'user' | 'assistant', text: string }>,
 *   actions?: Array<{ name: string, target: string, status: 'ok' | 'error' }>,
 *   attempt: number,
 *   previous?: string,
 * } | null} payload, or null when the turn is not ready.
 */
export function buildPromptPayload(messages, options = {}) {
  const turns = selectTurns(messages, options.maxTurns ?? 4, options.maxInputChars ?? 4000)
  if (turns.length === 0) return null

  /** @type {{ task?: string, language?: string, turns: Array<{ role: 'user' | 'assistant', text: string }>, actions?: Array<{ name: string, target: string, status: 'ok' | 'error' }>, attempt: number, previous?: string }} */
  const payload = { turns, attempt: options.attempt ?? 1 }
  const language = detectLanguage(turns)
  if (language !== null) payload.language = language

  const task = taskAnchor(messages)
  if (task !== '' && task.length >= 8 && !turns.some((turn) => turn.role === 'user' && turn.text.startsWith(task))) {
    payload.task = task
  }

  if (options.includeToolActivity !== false) {
    const actions = extractActions(messages, options.maxActions ?? MAX_ACTIONS, options.cwd ?? '')
    if (actions.length > 0) payload.actions = actions
  }

  const previous = oneLine(options.previous, 200)
  if (previous !== '') payload.previous = previous

  return payload
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
