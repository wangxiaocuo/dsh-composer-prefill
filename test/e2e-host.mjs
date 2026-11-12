/**
 * Real-Host end-to-end regression for the plugin's Host half.
 *
 * Boots the actual `dsh web` Host from a throwaway DSH home with this plugin
 * installed as a bundle in a generated `web` profile, redeems the launch token
 * and then hits the plugin's real HTTP surface. This is the only check that
 * proves the bundle loads inside a real Host: the config schema resolves, the
 * exact routes are registered, `ctx.connection.admit` accepts a real browser
 * session, and the no-model paths answer correctly.
 *
 * Run: node test/e2e-host.mjs
 *
 * The desktop app is discovered automatically; set `DSH_E2E_DSH_BIN` to the
 * `lib/bin.js` of an npm-installed `@deepseek-ai/dsh` to boot with plain Node
 * (what CI does). Set `DSH_E2E_KEEP=1` to keep the throwaway home and log.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  CSRF_HEADER,
  ROUTE_BASE,
  createApi,
  createProject,
  createRpc,
  createTempHome,
  resolveRuntime,
  startServer,
  stopServer,
  writeProfile,
  writeSession,
  writeWorkspaces,
} from './e2e/harness.mjs'

const keep = process.env.DSH_E2E_KEEP === '1'
const runtime = await resolveRuntime()
if (runtime === undefined) process.exit(0)

const home = await createTempHome('dsh-composer-prefill-host-e2e-')
let server
let failure = null
let passed = 0

/**
 * @param {string} name scenario label.
 * @returns {void}
 */
function pass(name) {
  passed += 1
  console.log(`ok ${name}`)
}

try {
  await writeProfile(home)
  const project = await createProject(home, 'project-e2e')
  const sessionId = 'session-e2e-idle'
  await writeSession(home, sessionId, project, { title: 'Composer prefill e2e' })
  await writeWorkspaces(home, [{ id: 'ws-e2e', path: project, sessionIds: [sessionId] }])

  server = await startServer(home, { runtime })
  const api = await createApi(server.url)

  const prefs = await api.call(`${ROUTE_BASE}/prefs`, { body: {} })
  assert.equal(prefs.status, 200, `prefs status ${prefs.status}`)
  assert.deepEqual(prefs.body, { ok: true, value: { enabled: true, entryId: 'composer-prefill' } })
  pass('the bundle loads in a real Host and reports its effective config + entry id')

  const predictUnknown = await api.call(`${ROUTE_BASE}/predict`, { body: { sessionId: 'session-does-not-exist' } })
  assert.equal(predictUnknown.status, 200)
  assert.deepEqual(predictUnknown.body, { ok: true, value: { enabled: true, text: null } })
  pass('an unknown session degrades to no suggestion without a model call')

  const badPayload = await api.call(`${ROUTE_BASE}/predict`, { body: { mode: 'cached' } })
  assert.equal(badPayload.status, 400)
  assert.equal(badPayload.body?.ok, false)
  assert.equal(badPayload.body?.error?.code, 'composer-prefill/bad-request')
  pass('a missing sessionId is rejected with the documented error code')

  const getPrefs = await api.call(`${ROUTE_BASE}/prefs`, { method: 'GET' })
  assert.equal(getPrefs.status, 405)
  assert.equal(getPrefs.headers.get('allow'), 'POST')
  pass('both endpoints are POST-only')

  const anonymous = await api.call(`${ROUTE_BASE}/prefs`, { body: {}, cookie: false })
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `anonymous status ${anonymous.status}`)
  assert.equal(anonymous.body?.ok, false)
  pass('the Connection fence rejects a request without a browser session')

  const noCsrf = await api.call(`${ROUTE_BASE}/prefs`, { body: {}, csrf: false })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body?.error?.code, 'forbidden')
  pass(`the endpoint requires the ${CSRF_HEADER} header`)

  const malformed = await api.call(`${ROUTE_BASE}/prefs`, { rawBody: '{' })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body?.error?.code, 'bad-request')
  pass('a malformed JSON body is a 400, not a crash')

  const notAnObject = await api.call(`${ROUTE_BASE}/prefs`, { rawBody: '[]' })
  assert.equal(notAnObject.status, 400)
  pass('a non-object JSON body is rejected')

  // The Host stops reading an over-limit body and destroys the request socket;
  // a real client can therefore observe either the 400 or a dropped
  // connection. Both mean the cap held.
  let oversizedStatus = null
  let oversizedBody = null
  try {
    const oversized = await api.call(`${ROUTE_BASE}/prefs`, {
      rawBody: JSON.stringify({ blob: 'x'.repeat(17 * 1024) }),
    })
    oversizedStatus = oversized.status
    oversizedBody = oversized.body
  } catch {
    oversizedStatus = 'connection-error'
  }
  if (oversizedStatus === 400) {
    assert.match(String(oversizedBody?.error?.message), /too large/i)
  } else {
    assert.equal(oversizedStatus, 'connection-error')
  }
  pass('the 16 KiB body cap is enforced')

  // The Host's own fallback answers unknown POST paths with 404 or 405; the
  // point is that neither of our handlers runs.
  // Settings → General writes through DSH's own settings document. That
  // document only exposes a namespace when the plugin Config has a volatile
  // field, so this scenario pins both directions of the persistence path that
  // the browser suite also exercises end to end.
  const rpc = createRpc(api)
  const describe = await rpc('settings/describe', {})
  assert.equal(describe.status, 200, `settings/describe status ${describe.status}`)
  const namespaces = describe.body?.result?.value?.namespaces ?? []
  const composerNamespace = namespaces.find((row) => row.ns === 'composer-prefill')
  assert.ok(composerNamespace, 'the composer-prefill settings namespace is missing (is showPredictions volatile?)')
  assert.deepEqual(Object.keys(composerNamespace.schema?.refs ?? {}).length > 0, true)
  pass('the settings document exposes the composer-prefill namespace')

  /** @param {boolean} enabled desired switch value. */
  async function setSwitch(enabled) {
    const mutate = await rpc('settings/mutate', {
      ns: 'composer-prefill',
      ops: [{ op: 'set', path: ['showPredictions'], value: enabled }],
    })
    assert.equal(mutate.status, 200, `settings/mutate status ${mutate.status}`)
    assert.equal(mutate.body?.result?.ok, true, `settings/mutate failed: ${JSON.stringify(mutate.body)}`)
    const deadline = Date.now() + 5_000
    for (;;) {
      const prefs = await api.call(`${ROUTE_BASE}/prefs`, { body: {} })
      if (prefs.body?.value?.enabled === enabled) return
      if (Date.now() > deadline) {
        throw new Error(`prefs never reported enabled:${enabled} after a settings write: ${JSON.stringify(prefs.body)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  await setSwitch(false)
  let patch = await fs.readFile(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').catch(() => '')
  assert.match(patch, /showPredictions:\s*false/, 'the switch write must land in the profile patch')
  pass('the settings switch turns the Host off and persists it to the profile patch')

  await setSwitch(true)
  patch = await fs.readFile(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').catch(() => '')
  assert.match(patch, /showPredictions:\s*true/, 'turning the switch back on must persist too')
  pass('the settings switch turns the Host back on and persists it')

  const wrongPath = await api.call(`${ROUTE_BASE}/prefss`, { body: {} })
  assert.ok([404, 405].includes(wrongPath.status), `wrong-path status ${wrongPath.status}`)
  pass('routes are exact paths, not prefixes')

  const unknownRoute = await api.call('/composer-prefill/nope', { body: {} })
  assert.ok([404, 405].includes(unknownRoute.status), `unknown-route status ${unknownRoute.status}`)
  pass('unknown plugin subpaths are not served')

  console.log(`\nhost e2e: all ${passed} checks passed`)
} catch (error) {
  failure = error
  if (server !== undefined) console.error(`\n--- dsh web log ---\n${server.log()}`)
} finally {
  if (server !== undefined) await stopServer(server.child)
  if (keep) console.log(`kept ${home}`)
  else await fs.rm(home, { recursive: true, force: true })
}

if (failure !== null) {
  console.error(`host e2e failed: ${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`)
  process.exit(1)
}
