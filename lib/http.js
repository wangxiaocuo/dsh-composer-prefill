/**
 * The plugin's HTTP surface: authenticated same-origin POST endpoints.
 *
 * Follows the pattern proven by `dsh-session-trash` in this profile: register
 * exact routes on `ctx.webServer`, then apply the Connection host/origin fence
 * and owner check with `ctx.connection.admit`.
 */

/** Prefix shared by every endpoint this plugin owns. */
export const ROUTE_BASE = '/composer-prefill'

/** Exact route for prediction requests. */
export const PREDICT_PATH = `${ROUTE_BASE}/predict`

/** Exact route for the settings row's read of the effective configuration. */
export const PREFS_PATH = `${ROUTE_BASE}/prefs`

/** Header that proves a same-origin scripted call (blocks simple form CSRF). */
export const CSRF_HEADER = 'x-dsh-composer-prefill'

/** Largest accepted request body. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * @param {import('node:http').IncomingMessage} req incoming request.
 * @returns {Headers} a Fetch-shaped header bag for the connection service.
 */
function headerBag(req) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else headers.set(name, value)
  }
  return headers
}

/**
 * @param {import('node:http').ServerResponse} res response to complete.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req request whose body to read.
 * @param {number} limit maximum accepted bytes.
 * @returns {Promise<Buffer>} the complete body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

/**
 * @param {Buffer} buffer raw request body.
 * @returns {Record<string, unknown>} decoded object.
 */
function parseJsonObject(buffer) {
  if (buffer.length === 0) return {}
  const parsed = JSON.parse(buffer.toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/**
 * Run the shared pipeline for one exact route.
 *
 * @param {object} ctx plugin context with `webServer` and `connection`.
 * @param {string} path exact route path.
 * @param {(payload: unknown, signal: AbortSignal | undefined) => Promise<object>} handle endpoint body.
 * @returns {void}
 */
function registerEndpoint(ctx, path, handle) {
  /**
   * @param {import('node:http').IncomingMessage} req incoming request.
   * @param {import('node:http').ServerResponse} res response to complete.
   * @returns {Promise<void>} completion.
   */
  async function serve(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use POST.' } })
      return
    }

    const headers = headerBag(req)
    let admission
    try {
      admission = ctx.connection.admit({ headers })
    } catch {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'The request could not be authenticated.' } })
      return
    }
    if (admission.rejection !== undefined) {
      sendJson(res, admission.rejection, { ok: false, error: { code: 'forbidden', message: 'The request is not trusted.' } })
      return
    }
    if (admission.peer?.principal?.kind !== 'owner') {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'Only the owner may use this plugin.' } })
      return
    }
    if (headers.get(CSRF_HEADER) !== '1') {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `Missing the ${CSRF_HEADER} header.` } })
      return
    }

    let payload
    try {
      payload = parseJsonObject(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
      return
    }

    // A closed request (page navigated away, suggestion no longer wanted)
    // aborts the model call instead of spending the tokens.
    const controller = new AbortController()
    req.on('close', () => controller.abort())

    try {
      const result = await handle(payload, controller.signal)
      sendJson(res, result.ok === true ? 200 : 400, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        async handler(req, res) {
          try {
            await serve(req, res)
          } catch (error) {
            if (!res.headersSent && !res.writableEnded) {
              sendJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
            }
          }
        },
      }),
    `composer-prefill: route ${path}`,
  )
}

/**
 * Register both endpoints.
 *
 * @param {object} ctx plugin context with `webServer` and `connection`.
 * @param {{ predict: (payload: unknown, signal: AbortSignal | undefined) => Promise<object>, prefs: () => Promise<object> }} handlers endpoint bodies.
 * @returns {void}
 */
export function registerApi(ctx, handlers) {
  registerEndpoint(ctx, PREDICT_PATH, handlers.predict)
  registerEndpoint(ctx, PREFS_PATH, handlers.prefs)
}
