/**
 * Real-browser end-to-end regression for the plugin's browser half.
 *
 * Boots the actual `dsh web` Host from a throwaway DSH home with this plugin
 * installed as a bundle in a generated `web` profile, then drives the shipped
 * web client with Playwright: the suggestion row above the composer, the four
 * row controls, and the Settings → General master switch. Only this level
 * proves the client bundle is injected into the real page, that the row docks
 * above the real Lexical composer, that accepting actually fills that composer,
 * and that the switch writes back through the real Host settings document.
 *
 * Run: node test/e2e-browser.mjs
 *
 * Output: one `ok <scenario>` line per check, then
 * `browser e2e: all N checks passed`. Exit 0 on pass and on a clean skip (no
 * Host runtime, no Playwright browser); exit 1 on a real failure with the
 * `dsh web` log tail and a screenshot path, so a CI run can upload it.
 *
 * The desktop app is discovered automatically; set `DSH_E2E_DSH_BIN` to the
 * `lib/bin.js` of an npm-installed `@deepseek-ai/dsh` to boot with plain Node
 * (what CI does). Chromium is expected under `PLAYWRIGHT_BROWSERS_PATH` or the
 * default Playwright cache; install it with `npx playwright install chromium`.
 * Set `DSH_E2E_KEEP=1` to keep the throwaway home for inspection.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ROUTE_BASE,
  createApi,
  createProject,
  createTempHome,
  resolveRuntime,
  startServer,
  stopServer,
  writeProfile,
  writeSession,
  writeWorkspaces,
} from './e2e/harness.mjs'

/** Text the mocked cached replay returns (the row must show exactly this). */
const CACHED_TEXT = 'Cached suggestion text'
/** Text the mocked reroll returns; must differ so the replacement is provable. */
const REFRESH_TEXT = 'Refresh suggestion text'
/** Accessible names of the row controls, from the plugin's English dictionary. */
const ACCEPT_NAME = 'Insert this suggestion'
const REROLL_NAME = 'Another suggestion'
const DISMISS_NAME = 'Dismiss this suggestion'
/** Settings switch: English plus the Chinese dictionary, so a locale change skips neither. */
const SETTINGS_SWITCH = /Composer predictions|输入预测/
/** Settings description that proves the row is wired to the live Host config. */
const SETTINGS_DESCRIPTION = /Each suggestion costs one extra model call/i
/** Select-all chord for the platform under test. */
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'

const keep = process.env.DSH_E2E_KEEP === '1'

/** Where a failure screenshot may be uploaded from in CI. */
function artifactDir() {
  const runnerTemp = process.env.RUNNER_TEMP
  return typeof runnerTemp === 'string' && runnerTemp !== '' ? runnerTemp : os.tmpdir()
}

/**
 * @param {number} ms delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll a predicate with a bounded deadline.
 *
 * @param {() => Promise<boolean> | boolean} predicate condition to reach.
 * @param {{ timeout?: number, interval?: number, message?: string }} [options] bounds and failure label.
 * @returns {Promise<void>} resolves once the predicate is true.
 */
async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 5_000
  const interval = options.interval ?? 100
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - startedAt > timeout) {
      throw new Error(`timed out after ${timeout}ms waiting for ${options.message ?? 'condition'}`)
    }
    await sleep(interval)
  }
}

/** Playwright import is optional: the suite skips cleanly on a machine without it. */
let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.log('browser e2e skipped: the `playwright` package is not installed.')
  console.log('install it with: pnpm add -D playwright && npx playwright install chromium')
  process.exit(0)
}

const runtime = await resolveRuntime()
// `resolveRuntime` prints its own actionable skip message and exits 0 itself
// when no Host is available; a broken explicit override fails there instead.
if (runtime === undefined) process.exit(0)

const home = await createTempHome('dsh-composer-prefill-browser-e2e-')
/** @type {Awaited<ReturnType<typeof startServer>> | undefined} */
let server
/** @type {import('playwright').Browser | undefined} */
let browser
/** @type {import('playwright').Page | undefined} */
let page
let failure = null
let skipped = false
let passed = 0
/** Failure screenshot path, captured before cleanup closes the page. */
let failureScreenshot = null
/** Uncaught page errors; the run must end clean. */
const pageErrors = []

/**
 * @param {string} name scenario label printed as `ok <name>`.
 * @returns {void}
 */
function pass(name) {
  passed += 1
  console.log(`ok ${name}`)
}

/**
 * Close every app-level startup dialog: the first-boot "Preview Notice"
 * (needs its `Continue`) and the sign-in "Get started" prompt (has `Close` /
 * `Escape`). Tolerates a build that shows none.
 *
 * @param {import('playwright').Page} target page under test.
 * @returns {Promise<void>} resolves once no dialog is open.
 */
async function settleStartupDialogs(target) {
  const dialog = target.locator('[role="dialog"]')
  // The notice renders just after the shell, so give it a bounded window. The
  // 6s cap keeps a future build without startup dialogs from stalling the suite.
  await dialog.first().waitFor({ state: 'visible', timeout: 6_000 }).catch(() => {})
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if ((await dialog.count()) === 0) {
      // One quiet check: a second dialog (Get started) follows the first.
      await sleep(250)
      if ((await dialog.count()) === 0) return
      continue
    }
    const current = dialog.first()
    const continueButton = current.getByRole('button', { name: /^continue$/i })
    const closeButton = current.getByRole('button', { name: /^close$/i })
    if ((await continueButton.count()) > 0) {
      await continueButton.first().click().catch(() => {})
    } else if ((await closeButton.count()) > 0) {
      await closeButton.first().click().catch(() => {})
    } else {
      // Last resort for a dialog with neither button. React's own Escape
      // handler calls preventDefault before the row's window listener runs, so
      // this cannot dismiss a suggestion.
      await target.keyboard.press('Escape')
    }
    await sleep(300)
  }
}

/**
 * Empty the Lexical composer through the shipped surface (no DOM pokes).
 *
 * @param {import('playwright').Page} target page under test.
 * @returns {Promise<void>} resolves after the draft empties.
 */
async function clearComposer(target) {
  const editable = target.locator('[contenteditable="true"]').first()
  await editable.click()
  await target.keyboard.press(SELECT_ALL)
  await target.keyboard.press('Backspace')
  // The Lexical state crosses a commit boundary, so wait for the empty draft.
  await waitFor(
    async () => {
      const content = await editable.innerText().catch(() => '')
      return content.trim() === ''
    },
    { timeout: 5_000, message: 'the composer draft to empty' },
  )
}

/**
 * Capture the failure screenshot while the page still exists (teardown closes
 * the browser before the report is printed).
 *
 * @returns {Promise<string | null>} absolute screenshot path, or null when unavailable.
 */
async function captureFailureScreenshot() {
  if (page === undefined) return null
  const target = path.join(artifactDir(), `composer-prefill-browser-e2e-${Date.now()}.png`)
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await page.screenshot({ path: target, fullPage: true })
    return target
  } catch {
    return null
  }
}

/**
 * Render the failure artifact: `dsh web` log tail and the screenshot path.
 *
 * @param {unknown} error failure to report.
 * @returns {void}
 */
function reportFailure(error) {
  console.error(`browser e2e failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  if (server !== undefined) console.error(`\n--- dsh web log (tail) ---\n${server.log().slice(-6_000)}`)
  else console.error('\n--- dsh web log (tail) ---\n(no host was started)')
  if (failureScreenshot !== null) console.error(`screenshot: ${failureScreenshot}`)
  else console.error('screenshot: unavailable (no screenshot could be captured)')
}

const startedAt = Date.now()
/** @type {Array<{ sessionId?: unknown, mode?: unknown }>} */
const predictRequests = []

try {
  await writeProfile(home)
  const project = await createProject(home, 'project-e2e')
  const sessionId = 'session-e2e-idle'
  await writeSession(home, sessionId, project, { title: 'Composer prefill e2e' })
  await writeWorkspaces(home, [{ id: 'ws-e2e', path: project, sessionIds: [sessionId] }])

  server = await startServer(home, { runtime })
  const api = await createApi(server.url)

  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Executable doesn't exist|does not exist at|npx playwright install/i.test(message)) {
      console.log('browser e2e skipped: Playwright cannot launch Chromium (browser binary missing).')
      console.log('install it with: npx playwright install chromium')
      console.log(`reason: ${message.split('\n')[0]}`)
      skipped = true
    } else {
      throw error
    }
  }

  if (!skipped) {
    const context = await browser.newContext({ locale: 'en-US' })
    page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(30_000)
    page.on('pageerror', (error) => {
      pageErrors.push(error instanceof Error ? error.message : String(error))
    })
    // The row's only Host call is a same-origin POST; fulfil it deterministically
    // so the suite never depends on a model, a cache, or the seeded session.
    await page.route('**/composer-prefill/predict', async (route) => {
      const body = route.request().postDataJSON()
      predictRequests.push(body !== null && typeof body === 'object' ? body : {})
      const mode = body !== null && typeof body === 'object' ? body.mode : undefined
      const text = mode === 'refresh' ? REFRESH_TEXT : CACHED_TEXT
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, value: { enabled: true, text } }),
      })
    })

    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    // The app auto-opens a brand-new session; the seeded sidebar session is only
    // there so the shell has real content. Never click it.
    const composer = page.locator('[data-composer-card]').first()
    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    await settleStartupDialogs(page)

    const row = page.locator('[data-composer-prefill]')
    await row.first().waitFor({ state: 'visible', timeout: 10_000 })

    // 1. The row appears on mount, fed by exactly one cached replay request.
    await sleep(300) // let any late duplicate mount request surface before counting
    const cached = predictRequests.filter((request) => request.mode === 'cached')
    assert.equal(cached.length, 1, `expected exactly one cached replay request, got ${JSON.stringify(predictRequests)}`)
    assert.equal(predictRequests.length, 1, `expected no other predict request on mount, got ${JSON.stringify(predictRequests)}`)
    assert.equal(typeof cached[0].sessionId, 'string', 'the cached request must name a session')
    assert.ok(cached[0].sessionId.length > 0, 'the cached request sessionId must be non-empty')
    assert.equal(await row.count(), 1, 'exactly one suggestion row')
    assert.match(await row.first().innerText(), new RegExp(CACHED_TEXT), 'the row shows the cached text')
    pass('the row appears on mount from one cached replay request for a real session id')

    // 2. Accept fills the real Lexical composer and hides the row.
    await page.getByRole('button', { name: ACCEPT_NAME }).click()
    await row.first().waitFor({ state: 'detached', timeout: 5_000 })
    const composerText = await composer.innerText()
    assert.ok(composerText.includes(CACHED_TEXT), `the composer should contain the suggestion, got ${JSON.stringify(composerText)}`)
    assert.equal(await page.locator('[contenteditable="true"]').first().innerText(), CACHED_TEXT, 'the editable holds the inserted text')
    pass('accept inserts the suggestion into the Lexical composer and removes the row')

    // 3. Clearing the draft restores the held suggestion with no Host request.
    await clearComposer(page)
    await row.first().waitFor({ state: 'visible', timeout: 5_000 })
    assert.equal(predictRequests.length, 1, `clearing must not refetch, got ${JSON.stringify(predictRequests)}`)
    assert.match(await row.first().innerText(), new RegExp(CACHED_TEXT), 'the restored row keeps the same text')
    pass('clearing the composer restores the held suggestion locally without a predict request')

    // 4. Typing hides the row immediately; clearing restores it locally again.
    const editable = page.locator('[contenteditable="true"]').first()
    await editable.click()
    await page.keyboard.type('draft text')
    await row.first().waitFor({ state: 'detached', timeout: 5_000 })
    assert.equal(predictRequests.length, 1, `typing must not refetch, got ${JSON.stringify(predictRequests)}`)
    await clearComposer(page)
    await row.first().waitFor({ state: 'visible', timeout: 5_000 })
    assert.equal(predictRequests.length, 1, `clearing after typing must stay request-free, got ${JSON.stringify(predictRequests)}`)
    pass('typing hides the row immediately and clearing restores it locally')

    // 5. Reroll asks the Host for a refresh and replaces the row text.
    await page.getByRole('button', { name: REROLL_NAME }).click()
    await waitFor(() => predictRequests.filter((request) => request.mode === 'refresh').length === 1, {
      timeout: 5_000,
      message: 'one refresh predict request',
    })
    assert.equal(predictRequests.filter((request) => request.mode === 'refresh').length, 1, 'exactly one reroll request')
    assert.equal(predictRequests.filter((request) => request.mode === 'cached').length, 1, 'reroll must not add a cached replay')
    await waitFor(
      async () => {
        const text = await row.first().innerText().catch(() => '')
        return text.includes(REFRESH_TEXT) && !text.includes(CACHED_TEXT)
      },
      { timeout: 5_000, message: 'the row to show the refreshed text' },
    )
    pass('reroll sends one mode:refresh request and replaces the row text')

    // 6. Dismiss suppresses the row until the next turn, even across clear.
    const requestCountAfterReroll = predictRequests.length
    await page.getByRole('button', { name: DISMISS_NAME }).click()
    await row.first().waitFor({ state: 'detached', timeout: 5_000 })
    await editable.click()
    await page.keyboard.type('ignored draft')
    await sleep(400)
    assert.equal(await row.count(), 0, 'typing after dismiss keeps the row away')
    await clearComposer(page)
    await sleep(600) // a wrongly-triggered restore would land in this window
    assert.equal(await row.count(), 0, 'clearing after dismiss must not restore the row')
    assert.equal(predictRequests.length, requestCountAfterReroll, `dismiss-then-clear must not fetch, got ${JSON.stringify(predictRequests)}`)
    pass('dismiss hides the row and typing then clearing neither restores it nor fetches')

    // 7. Settings → General mirrors and persists the master switch through the Host.
    await page.getByRole('button', { name: /^Account menu/ }).click()
    await page.getByText('Settings', { exact: true }).first().click()
    const settingsDialog = page.getByRole('dialog').first()
    await settingsDialog.waitFor({ state: 'visible', timeout: 10_000 })
    const predictionsSwitch = page.getByRole('switch', { name: SETTINGS_SWITCH })
    await predictionsSwitch.waitFor({ state: 'visible', timeout: 10_000 })
    // The row loads the effective Host value asynchronously; wait for the settled state.
    await waitFor(async () => (await predictionsSwitch.getAttribute('aria-checked')) === 'true', {
      timeout: 8_000,
      message: 'the switch to report aria-checked=true',
    })
    assert.equal(await predictionsSwitch.getAttribute('aria-checked'), 'true', 'the switch starts checked')
    assert.match(await settingsDialog.innerText(), SETTINGS_DESCRIPTION, 'the description names the extra model call')

    const prefsBefore = await api.call(`${ROUTE_BASE}/prefs`, { body: {} })
    assert.equal(prefsBefore.status, 200, `prefs status ${prefsBefore.status}`)
    assert.equal(prefsBefore.body?.value?.enabled, true, 'the Host starts enabled')

    await predictionsSwitch.click()
    await waitFor(async () => (await predictionsSwitch.getAttribute('aria-checked')) === 'false', {
      timeout: 5_000,
      message: 'the switch to report checked=false',
    })
    await waitFor(
      async () => (await api.call(`${ROUTE_BASE}/prefs`, { body: {} })).body?.value?.enabled === false,
      { timeout: 5_000, message: 'the real Host prefs to report enabled:false' },
    )
    await waitFor(async () => !(await predictionsSwitch.isDisabled()), { timeout: 5_000, message: 'the switch write to settle' })

    await predictionsSwitch.click()
    await waitFor(async () => (await predictionsSwitch.getAttribute('aria-checked')) === 'true', {
      timeout: 5_000,
      message: 'the switch to report checked=true again',
    })
    await waitFor(
      async () => (await api.call(`${ROUTE_BASE}/prefs`, { body: {} })).body?.value?.enabled === true,
      { timeout: 5_000, message: 'the real Host prefs to report enabled:true again' },
    )
    pass('the General switch shows checked and persists both directions through the real Host')

    // 8. Nothing on the page threw during the whole run.
    assert.deepEqual(pageErrors, [], `uncaught page errors: ${JSON.stringify(pageErrors)}`)
    pass('no uncaught page errors during the run')

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`browser e2e duration: ${seconds}s`)
    console.log(`\nbrowser e2e: all ${passed} checks passed`)
  }
} catch (error) {
  failure = error
  failureScreenshot = await captureFailureScreenshot()
} finally {
  if (browser !== undefined) await browser.close().catch(() => {})
  if (server !== undefined) await stopServer(server.child)
  if (keep) console.log(`kept ${home}`)
  else await fs.rm(home, { recursive: true, force: true })
}

if (failure !== null) {
  reportFailure(failure)
  process.exit(1)
}
if (skipped) process.exit(0)
