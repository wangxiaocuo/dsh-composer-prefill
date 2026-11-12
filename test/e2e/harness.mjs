/**
 * Shared bootstrap for the real-Host end-to-end suites.
 *
 * Both `test/e2e-host.mjs` and `test/e2e-browser.mjs` need the same expensive
 * setup: locate a runnable DeepSeek Harness CLI, create a throwaway DSH home, install
 * this plugin into a generated `web` profile, boot `dsh web`, and authenticate
 * with the launch token it prints. That lives here so the suites only describe
 * what they assert.
 *
 * Runtime resolution mirrors the author's dsh-session-trash e2e suite:
 *
 *   - `DSH_E2E_DSH_BIN` points at an npm-installed
 *     `@deepseek-ai/dsh/lib/bin.js`; the Host boots with plain Node. CI uses
 *     this mode.
 *   - otherwise the installed desktop app is discovered (or `DSH_ELECTRON` is
 *     used) and its bundled CLI runs under `ELECTRON_RUN_AS_NODE=1`.
 *   - when neither is available the caller prints a skip message and exits 0.
 *
 * The temporary home is never the user's real `~/.dsh`: sessions, profiles and
 * auth cookies all live under `os.tmpdir()`, and are removed on teardown.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (the plugin checked out here). */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Published package name; also the bundle id in the generated profile. */
export const PACKAGE_NAME = '@wangxiaocuo/dsh-composer-prefill'

/** Header the Host requires on POST, see lib/http.js. */
export const CSRF_HEADER = 'x-dsh-composer-prefill'

/** Endpoint base registered by lib/http.js. */
export const ROUTE_BASE = '/composer-prefill'

/**
 * @param {string} candidate path to probe.
 * @returns {Promise<boolean>} whether the path exists.
 */
export async function exists(candidate) {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Encode a workspace path the way DSH names the session directory.
 *
 * @param {string} cwd workspace path.
 * @returns {string} the directory name.
 */
export function projectName(cwd) {
  const readable = cwd.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '') || 'root'
  return `--${readable.slice(0, 251)}--`
}

/**
 * @returns {Promise<string | undefined>} the installed desktop executable.
 */
async function resolveElectron() {
  const override = process.env.DSH_ELECTRON
  const candidates =
    typeof override === 'string' && override !== ''
      ? [override]
      : process.platform === 'darwin'
        ? [
            '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
            path.join(os.homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness'),
          ]
        : process.platform === 'win32'
          ? [
              path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
              path.join(process.env.LOCALAPPDATA ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
              path.join(process.env.ProgramFiles ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
            ].filter((candidate) => path.isAbsolute(candidate))
          : [
              path.join(os.homedir(), '.local', 'bin', 'deepseek-harness'),
              '/opt/DeepSeek Harness/deepseek-harness',
            ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Locate the bundled `dsh` CLI inside the desktop app resources.
 *
 * @param {string} electron desktop executable path.
 * @returns {Promise<string | undefined>} CLI entry path.
 */
async function resolveDshBin(electron) {
  const executableDir = path.dirname(electron)
  const resourceRoots =
    process.platform === 'darwin'
      ? [path.join(executableDir, '..', 'Resources')]
      : [path.join(executableDir, 'resources'), path.join(executableDir, '..', 'resources')]
  const relative = path.join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  for (const resources of resourceRoots) {
    for (const bundle of ['app.asar', 'app']) {
      const base = path.join(resources, bundle)
      if (await exists(base)) return path.join(base, relative)
    }
  }
  return undefined
}

/**
 * Find a runnable Harness CLI.
 *
 * Returns `undefined` (after printing why) when no Host is available so the
 * caller can skip instead of failing a developer machine. A path explicitly
 * supplied through the environment is always validated: a broken override in CI
 * must fail, never silently skip.
 *
 * @returns {Promise<{ mode: 'cli' | 'desktop', command: string, bin: string, env: Record<string, string> } | undefined>} how to boot the Host.
 */
export async function resolveRuntime() {
  const override = process.env.DSH_E2E_DSH_BIN
  if (typeof override === 'string' && override !== '') {
    const bin = path.resolve(override)
    if (!(await exists(bin))) {
      console.error(`e2e failed: DSH_E2E_DSH_BIN does not exist: ${bin}`)
      process.exit(1)
    }
    return { mode: 'cli', command: process.execPath, bin, env: {} }
  }

  const electron = await resolveElectron()
  if (electron === undefined) {
    if (typeof process.env.DSH_ELECTRON === 'string' && process.env.DSH_ELECTRON !== '') {
      console.error(`e2e failed: DSH_ELECTRON does not exist: ${process.env.DSH_ELECTRON}`)
      process.exit(1)
    }
    console.log('e2e skipped: no DeepSeek Harness desktop found. Set DSH_ELECTRON to its executable path,')
    console.log('or DSH_E2E_DSH_BIN to the lib/bin.js of an npm-installed @deepseek-ai/dsh.')
    return undefined
  }

  const bin = await resolveDshBin(electron)
  if (bin === undefined) {
    if (typeof process.env.DSH_ELECTRON === 'string' && process.env.DSH_ELECTRON !== '') {
      console.error(`e2e failed: cannot locate the bundled dsh CLI inside ${path.dirname(electron)}.`)
      process.exit(1)
    }
    console.log(`e2e skipped: cannot locate the bundled dsh CLI inside ${path.dirname(electron)}.`)
    return undefined
  }
  return { mode: 'desktop', command: electron, bin, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * @param {string} prefix temporary-directory prefix.
 * @returns {Promise<string>} a fresh canonical DSH home.
 */
export async function createTempHome(prefix) {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return fs.realpath(raw)
}

/**
 * Generate the throwaway `web` profile that loads this plugin next to the
 * shipped web bundles.
 *
 * @param {string} home throwaway DSH home.
 * @returns {Promise<void>} resolution once the profile is ready.
 */
export async function writeProfile(home) {
  const profile = path.join(home, 'profiles', 'web')
  const linked = path.join(profile, 'node_modules', '@wangxiaocuo')
  await fs.mkdir(linked, { recursive: true })
  // A junction needs no extra privilege on Windows, unlike a directory symlink.
  await fs.symlink(REPO, path.join(linked, 'dsh-composer-prefill'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(
    path.join(profile, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { [PACKAGE_NAME]: `link:${REPO}` },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PACKAGE_NAME],
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n')
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  await fs.writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
}

/**
 * Create one project directory to hang a seeded workspace on.
 *
 * @param {string} home throwaway DSH home.
 * @param {string} name directory name below the home.
 * @returns {Promise<string>} absolute project path.
 */
export async function createProject(home, name) {
  const directory = path.join(home, name)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

/**
 * Materialize one session directory in the compressed JSONL layout the default
 * backend expects: the header line in the first zstd frame, then one
 * concatenated frame per extra event.
 *
 * @param {string} home throwaway DSH home.
 * @param {string} sessionId session identity.
 * @param {string} cwd project directory.
 * @param {{ title?: string, events?: object[] }} [extra] optional title event (the real title source) and raw extra events.
 * @returns {Promise<string>} the session-owned directory.
 */
export async function writeSession(home, sessionId, cwd, extra = {}) {
  const { zstdCompressSync } = await import('node:zlib')
  const directory = path.join(home, 'sessions', projectName(cwd), sessionId)
  await fs.mkdir(directory, { recursive: true })

  let seq = 0
  const frames = []
  /** @param {object} event log event. */
  const push = (event) => {
    frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
    seq += 1
  }

  push({
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: Date.now() - 60_000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  })
  if (typeof extra.title === 'string' && extra.title !== '') {
    push({ type: 'session/title', seq, time: Date.now() - 30_000, data: { title: extra.title, messageSeqs: [] } })
  }
  for (const event of extra.events ?? []) push({ ...event, seq: event.seq ?? seq })
  await fs.writeFile(path.join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return directory
}

/**
 * Write a durable workspace registry with an explicit session order per row.
 *
 * @param {string} home throwaway DSH home.
 * @param {{ id: string, path: string, sessionIds: string[] }[]} workspaces workspace rows.
 * @param {{ pinnedSessionIds?: string[], archivedSessionIds?: string[] }} [options] extra global flags.
 * @returns {Promise<void>} resolution once the registry is durable.
 */
export async function writeWorkspaces(home, workspaces, options = {}) {
  const now = new Date().toISOString()
  const tables = {}
  for (const workspace of workspaces) {
    tables[workspace.id] = {
      path: workspace.path,
      title: path.basename(workspace.path),
      sessionIds: workspace.sessionIds,
      createdAt: now,
      updatedAt: now,
    }
  }
  await fs.mkdir(path.join(home, 'storages'), { recursive: true })
  await fs.writeFile(
    path.join(home, 'storages', 'workspace.json'),
    `${JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: workspaces.map((workspace) => workspace.id),
          archivedSessionIds: options.archivedSessionIds ?? [],
          pinnedSessionIds: options.pinnedSessionIds ?? [],
        },
        tables: { workspaces: tables },
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * Boot `dsh web` in a throwaway home and wait for its authenticated URL.
 *
 * @param {string} home throwaway DSH home.
 * @param {{ runtime: Awaited<ReturnType<typeof resolveRuntime>>, timeoutMs?: number }} options runtime + launch budget.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string, log: () => string }>} the server handle.
 */
export async function startServer(home, { runtime, timeoutMs = 60_000 }) {
  if (runtime === undefined) throw new Error('startServer needs a resolved runtime')
  const child = spawn(runtime.command, [runtime.bin, 'web', '--no-open', '--port', '0'], {
    cwd: home,
    env: { ...process.env, ...runtime.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  let spawnError = null
  child.on('error', (error) => {
    spawnError = error
    log += `spawn error: ${error instanceof Error ? error.message : String(error)}\n`
  })
  child.stdout.on('data', (chunk) => {
    log += chunk
  })
  child.stderr.on('data', (chunk) => {
    log += chunk
  })

  let url
  try {
    url = await new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        if (spawnError !== null) {
          clearInterval(timer)
          reject(new Error(`cannot start dsh web: ${spawnError.message}`))
          return
        }
        const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
        if (match !== null) {
          clearInterval(timer)
          resolve(match[1])
          return
        }
        if (child.exitCode !== null) {
          clearInterval(timer)
          reject(new Error(`dsh web exited with code ${child.exitCode}:\n${log}`))
          return
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer)
          reject(new Error(`dsh web did not print a URL within ${timeoutMs}ms:\n${log}`))
        }
      }, 100)
    })
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
  return { child, url, log: () => log }
}

/**
 * @param {import('node:child_process').ChildProcess} child server process.
 * @returns {Promise<void>} resolution once the child is gone.
 */
export async function stopServer(child) {
  if (child.pid === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve(undefined))
  })
  const timeout = new Promise((resolve) => {
    const handle = setTimeout(() => resolve('timeout'), 5_000)
    handle.unref?.()
  })
  await Promise.race([exited, timeout])
  if (child.exitCode === null) child.kill('SIGKILL')
}

/**
 * Redeem the launch token and build a caller for this plugin's HTTP routes.
 *
 * The launch URL mints a browser cookie; the plugin's Connection fence accepts
 * that cookie plus the same-origin CSRF header, exactly like the browser half.
 *
 * @param {string} url printed launch URL.
 * @returns {Promise<{
 *   base: string,
 *   cookie: string,
 *   call: (route: string, options?: { method?: string, body?: object, headers?: Record<string, string>, csrf?: boolean, cookie?: boolean, rawBody?: string }) => Promise<{ status: number, body: any, headers: Headers }>,
 * }>} authenticator plus request helper.
 */
/**
 * Build the `/<namespace>/<method>` RPC caller the web client uses under
 * `/api/*`. The gateway expects a `client-request` envelope whose payload holds
 * exactly one plain-object `args` field.
 *
 * @param {Awaited<ReturnType<typeof createApi>>} api cookie-authenticated caller.
 * @returns {(method: string, args: object) => Promise<{ status: number, body: any, headers: Headers }>} RPC helper.
 */
export function createRpc(api) {
  let rpcId = 0
  return function rpc(method, args) {
    return api.call(`/api/${method}`, {
      body: { type: 'client-request', rpcId: String(++rpcId), method, payload: { args } },
    })
  }
}

export async function createApi(url) {
  const parsed = new URL(url)
  const base = parsed.origin
  const authenticated = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  if (Math.trunc(authenticated.status / 100) !== 3) {
    throw new Error(`the launch token did not redirect (status ${authenticated.status})`)
  }
  const setCookies =
    typeof authenticated.headers.getSetCookie === 'function'
      ? authenticated.headers.getSetCookie()
      : [authenticated.headers.get('set-cookie')].filter(Boolean)
  if (setCookies.length === 0) throw new Error('the launch token did not mint a browser cookie')
  const cookie = setCookies[0].split(';')[0]

  /**
   * @param {string} route endpoint path below the origin, e.g. `/composer-prefill/prefs`.
   * @param {object} [options] request facts.
   * @returns {Promise<{ status: number, body: any, headers: Headers }>} decoded answer.
   */
  async function call(route, options = {}) {
    const method = options.method ?? 'POST'
    const headers = {
      ...(options.cookie === false ? {} : { cookie }),
      ...(method === 'POST'
        ? {
            ...(options.csrf === false ? {} : { [CSRF_HEADER]: '1' }),
            'content-type': 'application/json',
          }
        : {}),
      ...(options.headers ?? {}),
    }
    const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed, headers: response.headers }
  }

  return { base, cookie, call }
}
