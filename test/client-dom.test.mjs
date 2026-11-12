/**
 * Browser-half behaviour test: loads `client.js` into a jsdom page, mounts both
 * registered rows with stand-in hooks, and drives them through a fake `fetch`.
 *
 * Run: node --test test/client-dom.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const SESSION = 'session-test'
const ENTRY_ID = 'include:composer-prefill'
const SUGGESTION_A = '继续，把测试跑一遍'
const SUGGESTION_B = '再补一个边界用例'
const SUGGESTION_C = '换一条试试'

const LABELS = {
  settingsTitle: '输入预测',
  settingsDescription: '助手回复后在输入框上方建议下一条消息。',
  settingsUnavailable: '宿主插件运行后可用。',
  accept: '填入这条建议',
  dismiss: '忽略这条建议',
  another: '换一条',
  thinking: '换一条中…',
}

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

/** Requests the rows made, in order. */
const calls = []
/** Replies for `/predict`, in order. */
let predictReplies = []
/** Reply for `/prefs`. */
let prefsReply = { enabled: true, entryId: ENTRY_ID }
/** Resolver of a deliberately pending `/predict` reply, when one is queued. */
let releasePending = null
/** Every `configForms` write the settings row made. */
const writes = []
/** Value the fake config form currently reports. */
let storedEnabled = true

globalThis.fetch = async (url, init) => {
  const target = String(url)
  calls.push({ url: target, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
  if (target.endsWith('/prefs')) return { ok: true, status: 200, json: async () => ({ ok: true, value: prefsReply }) }
  const next = predictReplies.length > 0 ? predictReplies.shift() : { enabled: true, text: null }
  if (next.deferred === true) {
    return new Promise((resolve) => {
      releasePending = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: next.value }) })
    })
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, value: next }) }
}

const configForm = {
  getSnapshot: () => ({ status: 'ready', value: { showPredictions: storedEnabled }, revision: 1, writable: true }),
  subscribe: () => () => {},
  set: (field, value) => {
    writes.push({ field, value })
    storedEnabled = value
    return Promise.resolve(true)
  },
}
const configForms = {
  get: (entryId) => {
    assert.equal(entryId, ENTRY_ID, 'the settings row addresses the reported entry id')
    return configForm
  },
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

/** Registered slot components, by slot name. */
const slots = {}
plugin.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {} },
  get: (name) => (name === 'configForms' ? configForms : undefined),
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, Component) => {
      slots[options.name] = Component
      return () => {}
    },
  },
})
const Row = slots['conversation.input.dock']
const SettingsRow = slots['settings.general.item']
assert.equal(typeof Row, 'function', 'the suggestion row is registered into the dock slot')
assert.equal(typeof SettingsRow, 'function', 'the settings row is registered into the general slot')

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

/**
 * Mount any component into a fresh container.
 *
 * @param {Function} Component registered slot component.
 * @param {() => object} element builds the element.
 * @returns {{ root: any, container: HTMLElement, render: () => Promise<void>, text: () => string, teardown: () => Promise<void> }} harness.
 */
function mount(Component, element) {
  const container = document.getElementById('root')
  container.innerHTML = ''
  const root = createRoot(container)
  return {
    root,
    container,
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
 * Mount the suggestion row with controllable session state.
 *
 * @returns {object} harness with `state`, `accepted` and the generic helpers.
 */
function mountRow() {
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
  const harness = mount(Row, () =>
    React.createElement(Row, {
      sessionId: SESSION,
      inputActions,
      t: (key) => LABELS[key] ?? key,
      useInput: (selector) => selector({ draft: state.draft, attachmentIds: [], phase: state.phase }),
      useSessionStatus: (selector) => selector(new Map([[SESSION, { running: state.running }]])),
    }),
  )
  return { ...harness, state, accepted }
}

/**
 * Mount the Settings → General row.
 *
 * @returns {object} mount harness plus the switch query.
 */
function mountSettings() {
  const harness = mount(SettingsRow, () => React.createElement(SettingsRow, { t: (key) => LABELS[key] ?? key }))
  return {
    ...harness,
    switchButton: () => document.querySelector('button[role="switch"]'),
  }
}

test.beforeEach(() => {
  calls.length = 0
  writes.length = 0
  releasePending = null
  predictReplies = []
  prefsReply = { enabled: true, entryId: ENTRY_ID }
  storedEnabled = true
})

test('mounting on an idle session asks for a cached suggestion and shows it', async () => {
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  assert.equal(calls.length, 1, 'one request on mount')
  assert.deepEqual(calls[0].body, { sessionId: SESSION, mode: 'cached' }, 'mount uses the cached-only mode')
  assert.match(row.text(), new RegExp(SUGGESTION_A))
  await row.teardown()
})

test('typing hides the row and clearing restores it without another request', async () => {
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
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
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  row.state.running = true
  await row.render()
  assert.doesNotMatch(row.text(), new RegExp(SUGGESTION_A), 'nothing shows during a turn')

  predictReplies.push({ enabled: true, text: SUGGESTION_B })
  row.state.running = false
  await row.render()

  assert.deepEqual(calls.at(-1).body, { sessionId: SESSION }, 'a turn end uses the generating mode')
  assert.match(row.text(), new RegExp(SUGGESTION_B), 'the new suggestion replaces the old one')
  await row.teardown()
})

test('the reroll button shows progress, asks for a refresh and replaces the text', async () => {
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  const reroll = document.querySelector('button[data-composer-prefill-reroll]')
  assert.ok(reroll, 'the reroll button exists')
  predictReplies.push({ deferred: true, value: { enabled: true, text: SUGGESTION_C } })
  await React.act(async () => {
    reroll.click()
  })
  assert.deepEqual(calls.at(-1).body, { sessionId: SESSION, mode: 'refresh' }, 'reroll asks for a refresh')
  assert.match(row.text(), new RegExp(LABELS.thinking), 'the row shows progress while rerolling')

  await React.act(async () => {
    releasePending()
  })
  await flush()
  assert.match(row.text(), new RegExp(SUGGESTION_C), 'the rerolled text replaces the old one')
  await row.teardown()
})

test('a reroll that yields nothing keeps the current suggestion', async () => {
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  predictReplies.push({ enabled: true, text: null })
  await React.act(async () => {
    document.querySelector('button[data-composer-prefill-reroll]').click()
  })
  await flush()
  assert.match(row.text(), new RegExp(SUGGESTION_A), 'the old suggestion survives an empty reroll')
  await row.teardown()
})

test('dismissing suppresses the suggestion until the next turn', async () => {
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
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

  row.state.running = true
  await row.render()
  predictReplies.push({ enabled: true, text: SUGGESTION_B })
  row.state.running = false
  await row.render()
  assert.match(row.text(), new RegExp(SUGGESTION_B), 'a new turn may suggest again')
  await row.teardown()
})

test('clicking the text accepts it into the composer', async () => {
  const row = mountRow()
  predictReplies.push({ enabled: true, text: SUGGESTION_A })
  await row.render()

  const acceptButton = [...document.querySelectorAll('button')].find((button) => button.textContent === SUGGESTION_A)
  assert.ok(acceptButton, 'the suggestion is a button')
  await React.act(async () => {
    acceptButton.click()
  })
  assert.deepEqual(row.accepted, [SUGGESTION_A], 'the exact suggestion text is inserted')
  await row.teardown()
})

test('the settings row reads the switch, then writes it through the config form', async () => {
  storedEnabled = false
  prefsReply = { enabled: false, entryId: ENTRY_ID }
  const settings = mountSettings()
  await settings.render()

  assert.match(settings.text(), new RegExp(LABELS.settingsTitle), 'the row shows its title')
  assert.ok(calls.some((entry) => entry.url.endsWith('/prefs')), 'the row asks the Host for its state')

  const toggle = settings.switchButton()
  assert.ok(toggle, 'the switch exists')
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'the switch starts in the stored state')

  await React.act(async () => {
    toggle.click()
  })
  await flush()

  assert.deepEqual(writes, [{ field: 'showPredictions', value: true }], 'the switch writes the config field')
  assert.equal(settings.switchButton().getAttribute('aria-checked'), 'true', 'the switch reflects the new value')
  await settings.teardown()
})
