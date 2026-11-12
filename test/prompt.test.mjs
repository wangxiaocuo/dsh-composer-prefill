import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSystemPrompt, sanitizePrediction, selectTurns } from '../lib/prompt.js'

/**
 * @param {string} text one text block.
 * @returns {{ role: string, content: Array<{ type: string, text: string }> }} a message.
 */
function user(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * @param {string} text one text block.
 * @returns {{ role: string, content: Array<{ type: string, text: string }> }} a message.
 */
function assistant(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

test('selectTurns keeps only user/assistant text and drops other block kinds', () => {
  const messages = [
    user('first question'),
    assistant('answer'),
    { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'hidden thinking' }] },
  ]
  assert.deepEqual(selectTurns(messages, 4, 4000), [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'answer' },
  ])
})

test('selectTurns joins every text block of one message', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'line one' }, { type: 'image' }, { type: 'text', text: 'line two' }] }
  assert.deepEqual(selectTurns([message], 4, 4000), [{ role: 'assistant', text: 'line one\nline two' }])
})

test('selectTurns keeps the most recent turns within maxTurns', () => {
  const messages = [user('q1'), assistant('a1'), user('q2'), assistant('a2'), user('q3'), assistant('a3')]
  assert.deepEqual(selectTurns(messages, 2, 4000), [
    { role: 'user', text: 'q2' },
    { role: 'assistant', text: 'a2' },
    { role: 'user', text: 'q3' },
    { role: 'assistant', text: 'a3' },
  ])
})

test('selectTurns trims from the front until the budget fits', () => {
  const messages = [user('x'.repeat(100)), assistant('y'.repeat(100)), user('z'.repeat(100))]
  const turns = selectTurns(messages, 4, 150)
  assert.ok(turns.length < 3, 'drops the oldest messages')
  const total = turns.reduce((sum, turn) => sum + turn.text.length, 0)
  assert.ok(total <= 150, 'stays within the character budget')
})

test('selectTurns is empty for unusable input', () => {
  assert.deepEqual(selectTurns(undefined, 4, 4000), [])
  assert.deepEqual(selectTurns([], 4, 4000), [])
  assert.deepEqual(selectTurns([user('only user')], 0, 4000), [])
})

test('sanitizePrediction strips wrapping quotes, bullets and whitespace', () => {
  assert.equal(sanitizePrediction('"继续，把测试跑一遍"', 200), '继续，把测试跑一遍')
  assert.equal(sanitizePrediction('- run the tests', 200), 'run the tests')
  assert.equal(sanitizePrediction('  spaced   out  ', 200), 'spaced out')
  assert.equal(sanitizePrediction('first line\nsecond line', 200), 'first line')
})

test('sanitizePrediction treats the none sentinel and junk as no prediction', () => {
  assert.equal(sanitizePrediction('NONE', 200), null)
  assert.equal(sanitizePrediction('none.', 200), null)
  assert.equal(sanitizePrediction('<none>', 200), null)
  assert.equal(sanitizePrediction('   \n  ', 200), null)
  assert.equal(sanitizePrediction('', 200), null)
  assert.equal(sanitizePrediction(undefined, 200), null)
  assert.equal(sanitizePrediction('a', 200), null)
})

test('sanitizePrediction caps the returned length', () => {
  const long = 'x'.repeat(500)
  assert.equal(sanitizePrediction(long, 200).length, 200)
})

test('loadSystemPrompt returns the shipped prompt', () => {
  const prompt = loadSystemPrompt()
  assert.ok(prompt.length > 80, 'prompt is not the tiny fallback')
  assert.match(prompt, /NONE/)
})
