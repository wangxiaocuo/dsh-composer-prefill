import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPromptPayload,
  detectLanguage,
  extractActions,
  loadSystemPrompt,
  sanitizePrediction,
  selectTurns,
} from '../lib/prompt.js'

/**
 * @param {string} text one text block.
 * @param {object} [extra] extra message fields, such as `source`.
 * @returns {{ role: string, content: Array<{ type: string, text: string }> }} a message.
 */
function user(text, extra = {}) {
  return { role: 'user', content: [{ type: 'text', text }], ...extra }
}

/**
 * @param {string} text one text block.
 * @param {object} [extra] extra message fields.
 * @returns {{ role: string, content: Array<{ type: string, text: string }> }} a message.
 */
function assistant(text, extra = {}) {
  return { role: 'assistant', content: [{ type: 'text', text }], ...extra }
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
  assert.deepEqual(selectTurns([user('q'), message], 4, 4000), [
    { role: 'user', text: 'q' },
    { role: 'assistant', text: 'line one\nline two' },
  ])
})

test('selectTurns ignores Harness-injected user messages', () => {
  const messages = [
    user('real request'),
    user('Current working directory: /tmp', { source: { kind: 'runtime-context' } }),
    user('A skill catalog that is enormous', { source: { kind: 'skill-catalog' } }),
    assistant('real answer'),
    user('Time sampled while preparing turn 1', { source: { kind: 'time-context' } }),
  ]
  assert.deepEqual(selectTurns(messages, 4, 4000), [
    { role: 'user', text: 'real request' },
    { role: 'assistant', text: 'real answer' },
  ])
})

test('selectTurns keeps a scheduled or plugin prompt but drops known injections', () => {
  const messages = [
    user('run the nightly report', { source: { kind: 'schedule' } }),
    assistant('report done'),
    user('Time sampled while preparing step 2', { source: { kind: 'time-context' } }),
  ]
  assert.deepEqual(selectTurns(messages, 4, 4000), [
    { role: 'user', text: 'run the nightly report' },
    { role: 'assistant', text: 'report done' },
  ])
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
  const messages = [user('x'.repeat(100)), assistant('y'.repeat(100)), user('z'.repeat(100)), assistant('w'.repeat(100))]
  const turns = selectTurns(messages, 4, 150)
  assert.deepEqual(turns, [
    { role: 'user', text: 'z'.repeat(100) },
    { role: 'assistant', text: 'w'.repeat(100) },
  ])
  const total = turns.reduce((sum, turn) => sum + turn.text.length, 0)
  assert.ok(total <= 200, 'keeps at least one whole turn')
})

test('selectTurns keeps both ends of a long message so the question survives', () => {
  const long = `${'plan '.repeat(300)}最后一句：你希望我现在就发布吗？`
  const turns = selectTurns([user('ship it?'), assistant(long)], 4, 4000)
  const turn = turns[turns.length - 1]
  assert.equal(turn.role, 'assistant')
  assert.ok(turn.text.startsWith('plan'), 'keeps the opening')
  assert.ok(turn.text.endsWith('你希望我现在就发布吗？'), 'keeps the final question')
  assert.ok(turn.text.length <= 1502, 'stays near the per-message cap')
})

test('selectTurns refuses a turn that has no completed assistant reply', () => {
  assert.deepEqual(selectTurns([user('q1'), assistant('a1'), user('q2')], 4, 4000), [])
  assert.deepEqual(selectTurns([user('only user')], 4, 4000), [])
  assert.deepEqual(selectTurns([], 4, 4000), [])
  assert.deepEqual(selectTurns(undefined, 4, 4000), [])
  assert.deepEqual(selectTurns([user('q')], 0, 4000), [])
})

test('extractActions keeps tool names, short targets and outcomes', () => {
  const messages = [
    user('run the tests'),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running them.' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', description: 'Run unit tests' }) },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: JSON.stringify({ file_path: '/tmp/notes.md' }) },
      ],
    },
    { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] },
    { role: 'tool', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'file body' }] },
    assistant('tests fail'),
  ]
  assert.deepEqual(extractActions(messages, 6), [
    { name: 'bash', target: 'pnpm test', status: 'error' },
    { name: 'read', target: '/tmp/notes.md', status: 'ok' },
  ])
})

test('extractActions strips shell setup, shortens the cwd and de-duplicates polling', () => {
  const cwd = '/Users/wxc/repo'
  const messages = [
    user('check CI'),
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: JSON.stringify({ command: `sleep 40; cd ${cwd} && npm run verify 2>&1 | tail -5` }) },
        { type: 'tool-call', id: 'c2', name: 'bash', arguments: JSON.stringify({ command: `cd ${cwd} && gh run list --workflow=ci.yml` }) },
        { type: 'tool-call', id: 'c3', name: 'bash', arguments: JSON.stringify({ command: `sleep 40; cd ${cwd} && gh run list --workflow=ci.yml` }) },
        { type: 'tool-call', id: 'c4', name: 'read', arguments: JSON.stringify({ file_path: `${cwd}/lib/prompt.js` }) },
      ],
    },
    assistant('CI finished.'),
  ]
  assert.deepEqual(extractActions(messages, 4, cwd), [
    { name: 'bash', target: 'npm run verify', status: 'ok' },
    { name: 'bash', target: 'gh run list --workflow=ci.yml', status: 'ok' },
    { name: 'read', target: './lib/prompt.js', status: 'ok' },
  ])
})

test('extractActions only looks at the latest turn and never returns output', () => {
  const messages = [
    user('first'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'old', name: 'bash', arguments: '{"command":"rm -rf /tmp/old"}' }] },
    user('second'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'new', name: 'bash', arguments: 'not json' }] },
    { role: 'tool', toolCallId: 'new', isError: false, content: [{ type: 'text', text: 'secret output' }] },
    assistant('done'),
  ]
  assert.deepEqual(extractActions(messages, 6), [{ name: 'bash', target: 'not json', status: 'ok' }])
})

test('detectLanguage names the script of the latest user messages', () => {
  assert.equal(detectLanguage([{ role: 'user', text: '帮我看下这个报错' }]), 'Chinese')
  assert.equal(detectLanguage([{ role: 'user', text: 'テストが落ちています' }]), 'Japanese')
  assert.equal(detectLanguage([{ role: 'user', text: '테스트가 실패했어요' }]), 'Korean')
  assert.equal(detectLanguage([{ role: 'user', text: 'run the tests' }]), 'English')
  assert.equal(detectLanguage([{ role: 'user', text: '¿puedes revisar la configuración?' }]), null)
  assert.equal(detectLanguage([]), null)
})

test('buildPromptPayload adds the task anchor, language, actions and reroll context', () => {
  const messages = [
    user('重构预测插件的提示词，让它更贴合当前会话'),
    assistant('先看一下现在的实现。'),
    user('把提示词改好，再补测试'),
    assistant('已经改好并补了测试。'),
    user('再确认一下没有回归'),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '改好了，测试也补了。' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'all green' }] },
  ]
  const payload = buildPromptPayload(messages, { maxTurns: 2, attempt: 2, previous: '跑一下 pnpm test' })
  assert.equal(payload.task, '重构预测插件的提示词，让它更贴合当前会话')
  assert.equal(payload.language, 'Chinese')
  assert.equal(payload.attempt, 2)
  assert.equal(payload.previous, '跑一下 pnpm test')
  assert.deepEqual(payload.actions, [{ name: 'bash', target: 'pnpm test', status: 'ok' }])
  assert.deepEqual(payload.turns.at(-1), { role: 'assistant', text: '改好了，测试也补了。' })
})

test('buildPromptPayload can omit tool activity and returns null for a busy turn', () => {
  const messages = [
    user('fix the build'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pnpm build"}' }] },
    { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'failed' }] },
  ]
  assert.equal(buildPromptPayload(messages), null, 'no completed assistant reply yet')

  const completed = [...messages, assistant('The build is green now.')]
  assert.equal(buildPromptPayload(completed, { includeToolActivity: false }).actions, undefined)
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
  assert.match(prompt, /NONE.*assistant|assistant.*NONE/s, 'the abstain rule names the incomplete turn')
})
