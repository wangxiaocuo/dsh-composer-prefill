/**
 * Browser-half behaviour test: loads `client.js` into a jsdom page, mounts the
 * slot row with stand-in session hooks, and drives the trigger state machine
 * through a fake `fetch`.
 *
 * Run: node --test test/client-dom.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const SESSION = 'session-test'
const SUGGESTION_A = '继续，把测试跑一遍'
const SUGGESTION_B = '再补一个边界用例'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:5123/',
  pretendToBeVisual: true,
})
// `navigator` already exists on modern Node and is getter-only, so only the
// DOM globals the client actually reads are installed here.
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = await import('react')
const { createRoot } = await import('react-dom/client')

/** Every request the row made, in order. */
const calls = []
/** Replies the current test wants the endpoint to give, in order. */
let replies = []

globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(init.body) })
  const value = replies.length > 0 ? replies.shift() : { enabled: true, text: null }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value }),
  }
}

let module = null
window.__ModuleLoader__ = {
  load(definition) {
    module = definition
  },
}
await import('../client.js')
assert.equal(module?.id, '@wangxiaocuo/dsh-composer-prefill', 'client module registers under the package id')

const plugin = module.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

let Row = null
plugin.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {} },
  slots: {
    inject: (_key, callback) => callback(),
    register: (_options, Component) => {
      Row = Component
      return () => {}
    },
  },
})
assert.equal(typeof Row, 'function', 'the row is registered into the dock slot')

/**
 * Mount a fresh row with controllable session state.
 *
 * @returns {{
 *   state: { draft: string, running: boolean, phase: string },
 *   accepted: string[],
 *   render: () => Promise<void>,
 *   flush: () => Promise<void>,
 *   text: () => string,
 *   teardown: () => Promise<void>,
 * }} harness.
 */
function mount() {
  const container = document.getElementById('root')
  container.innerHTML = ''
  const root = createRoot(container)
  const state = { draft: '', running: false, phase: 'plain' }
  const accepted = []
  const inputActions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: (text) => {
      accepted.push(text)
      return true
    },
    persistDraft: () => {},
  }
  const element = () =>
    React.createElement(Row, {
      sessionId: SESSION,
      inputActions,
      t: (key) => key,
      useInput: (selector) => selector({ draft: state.draft, attachmentIds: [], phase: state.phase }),
      useSessionStatus: (selector) => selector(new Map([[SESSION, { running: state.running }]])),
    })

  return {
    state,
    accepted,
    async render() {
      await React.act(async () => {
        root.render(element())
      })
      await flush()
    },
    async teardown() {
      await React.act(async () => {
        root.unmount()
      })
    },
    text: () => container.textContent ?? '',
  }
}

/**
 * Let pending promise chains and effects settle.
 *
 * @returns {Promise<void>} completion.
 */
async function flush() {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test.beforeEach(() => {
  calls.length = 0
  replies = []
})

test('mounting on an idle session asks for a cached suggestion and shows it', async () => {
  const row = mount()
  replies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  assert.equal(calls.length, 1, 'one request on mount')
  assert.deepEqual(calls[0].body, { sessionId: SESSION, mode: 'cached' }, 'mount uses the cached-only mode')
  assert.match(row.text(), new RegExp(SUGGESTION_A))
  await row.teardown()
})

test('typing hides the row and clearing restores it without another request', async () => {
  const row = mount()
  replies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()
  const requestCount = calls.length

  row.state.draft = 'hello'
  await row.render()
  assert.doesNotMatch(row.text(), new RegExp(SUGGESTION_A), 'the row hides while composing')

  row.state.draft = ''
  await row.render()
  assert.match(row.text(), new RegExp(SUGGESTION_A), 'clearing the draft restores the suggestion')
  assert.equal(calls.length, requestCount, 'restoration costs no request')
  await row.teardown()
})

test('a finished turn generates once, and a new turn replaces the text', async () => {
  const row = mount()
  replies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  // A turn runs, then ends: the row must ask for a fresh suggestion.
  row.state.running = true
  await row.render()
  assert.doesNotMatch(row.text(), new RegExp(SUGGESTION_A), 'nothing shows during a turn')

  replies.push({ enabled: true, text: SUGGESTION_B })
  row.state.running = false
  await row.render()

  const generateCall = calls.at(-1)
  assert.deepEqual(generateCall.body, { sessionId: SESSION }, 'a turn end uses the generating mode')
  assert.match(row.text(), new RegExp(SUGGESTION_B), 'the new suggestion replaces the old one')
  await row.teardown()
})

test('dismissing suppresses the suggestion until the next turn', async () => {
  const row = mount()
  replies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  const closeButton = [...document.querySelectorAll('button')].find((button) => button.textContent === '✕')
  assert.ok(closeButton, 'the dismiss button exists')
  await React.act(async () => {
    closeButton.click()
  })
  assert.doesNotMatch(row.text(), new RegExp(SUGGESTION_A), 'dismiss hides the row')

  row.state.draft = 'x'
  await row.render()
  row.state.draft = ''
  await row.render()
  assert.doesNotMatch(row.text(), new RegExp(SUGGESTION_A), 'a dismissal survives clearing the draft')

  // The next turn resets the dismissal.
  row.state.running = true
  await row.render()
  replies.push({ enabled: true, text: SUGGESTION_B })
  row.state.running = false
  await row.render()
  assert.match(row.text(), new RegExp(SUGGESTION_B), 'a new turn may suggest again')
  await row.teardown()
})

test('clicking the text accepts it into the composer', async () => {
  const row = mount()
  replies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  const acceptButton = [...document.querySelectorAll('button')].find((button) => button.textContent === SUGGESTION_A)
  assert.ok(acceptButton, 'the suggestion is a button')
  await React.act(async () => {
    acceptButton.click()
  })
  assert.deepEqual(row.accepted, [SUGGESTION_A], 'the exact suggestion text is inserted')
  await row.teardown()
})
