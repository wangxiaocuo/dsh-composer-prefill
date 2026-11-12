/**
 * Unit tests for `lib/http.js`: route registration, the Connection owner fence,
 * request parsing/limits, abort-on-close and the JSON response contract.
 *
 * Request/response stand-ins mirror the shapes at the top of
 * `test/smoke-host.mjs`, so the whole pipeline runs without a live server or
 * any network I/O.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { CSRF_HEADER, PREDICT_PATH, PREFS_PATH, ROUTE_BASE, registerApi } from '../lib/http.js'

const PREDICT = '/composer-prefill/predict'
const PREFS = '/composer-prefill/prefs'

/**
 * @param {{ method?: string, headers?: Record<string, unknown> }} [options] request shape.
 * @returns {EventEmitter & { method: string, headers: object, destroy: Function, destroyed: boolean }} stand-in IncomingMessage.
 */
function fakeRequest({ method = 'POST', headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.destroyed = false
  req.destroy = () => {
    req.destroyed = true
  }
  return req
}

/**
 * @returns {object} stand-in ServerResponse with the fields the module touches.
 */
function fakeResponse() {
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      res.statusCode = status
      for (const [name, value] of Object.entries(headers ?? {})) res.headers[name.toLowerCase()] = value
      res.headersSent = true
    },
    end(payload) {
      res.writableEnded = true
      if (payload !== undefined) res.body = String(payload)
    },
  }
  return res
}

/**
 * @param {{ method?: string, headers?: Record<string, unknown> }} [options] overrides.
 * @returns {object} a POST request that satisfies the auth/CSRF preconditions.
 */
function authorizedRequest({ method = 'POST', headers = {} } = {}) {
  return fakeRequest({ method, headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', ...headers } })
}

/**
 * @param {object} res fake response.
 * @returns {unknown} decoded body, or undefined when nothing was written.
 */
function jsonOf(res) {
  return res.body === '' ? undefined : JSON.parse(res.body)
}

/**
 * @param {Function} handler the registered route handler.
 * @param {{ req?: object, res?: object, body?: string | string[], finish?: 'end' | 'error' | 'aborted' | 'none' }} [options] request shape.
 * @returns {Promise<object>} the fake response after the handler settles.
 */
async function invoke(handler, { req = authorizedRequest(), res = fakeResponse(), body, finish = 'end' } = {}) {
  const pending = handler(req, res)
  if (body !== undefined) {
    for (const piece of Array.isArray(body) ? body : [body]) req.emit('data', Buffer.from(piece))
  }
  if (finish === 'error') req.emit('error', new Error('socket error'))
  else if (finish === 'aborted') req.emit('aborted')
  else if (finish === 'end') req.emit('end')
  await pending
  return res
}

/**
 * @returns {{ promise: Promise<unknown>, resolve: (value: unknown) => void }} manually settled promise.
 */
function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

/**
 * @returns {Promise<void>} resolves after the pending I/O callbacks run.
 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Register both endpoints against a stubbed context.
 *
 * @param {{ admit?: Function, predict?: Function, prefs?: Function }} [options] stubs.
 * @returns {{ routes: object[], effects: string[], calls: { predict: object[], prefs: object[] }, handlerFor: (path: string) => Function, disposed: Function[] }} harness.
 */
function makeApi({ admit, predict, prefs } = {}) {
  const routes = []
  const effects = []
  const disposed = []
  const calls = { predict: [], prefs: [] }
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { admit: admit ?? (() => ({ peer: { principal: { kind: 'owner' } } })) },
    effect(fn, label) {
      effects.push(label)
      disposed.push(fn())
    },
  }
  registerApi(ctx, {
    predict: (payload, signal) => {
      calls.predict.push({ payload, signal })
      return Promise.resolve(predict === undefined ? { ok: true, value: { enabled: true, text: '继续，把测试跑一遍' } } : predict(payload, signal))
    },
    prefs: (payload, signal) => {
      calls.prefs.push({ payload, signal })
      return Promise.resolve(prefs === undefined ? { ok: true, value: { enabled: true, entryId: null } } : prefs(payload, signal))
    },
  })
  const handlerFor = (path) => {
    const route = routes.find((candidate) => candidate.path === path)
    assert.ok(route, `route ${path} is registered`)
    return route.handler
  }
  return { routes, effects, calls, handlerFor, disposed }
}

test('both endpoints are registered as exact routes under the shared base', async () => {
  assert.equal(ROUTE_BASE, '/composer-prefill')
  assert.equal(PREDICT_PATH, PREDICT)
  assert.equal(PREFS_PATH, PREFS)

  const api = makeApi()
  assert.deepEqual(api.routes.map((route) => route.path), [PREDICT, PREFS])
  assert.ok(api.routes.every((route) => route.kind === 'exact'))
  assert.deepEqual(api.effects, [`composer-prefill: route ${PREDICT}`, `composer-prefill: route ${PREFS}`])
  for (const dispose of api.disposed) assert.doesNotThrow(() => dispose())
})

test('a non-POST method is rejected before any auth or body work', async () => {
  for (const method of ['GET', 'PUT', 'post']) {
    const api = makeApi()
    const res = await invoke(api.handlerFor(PREDICT), { req: authorizedRequest({ method }), finish: 'none' })
    assert.equal(res.statusCode, 405, `${method} is rejected`)
    assert.equal(res.headers.allow, 'POST')
    assert.equal(jsonOf(res).error.code, 'method-not-allowed')
    assert.equal(api.calls.predict.length, 0)
  }
})

test('a throwing admission service is forbidden', async () => {
  const api = makeApi({
    admit: () => {
      throw new Error('untrusted origin')
    },
  })
  const res = await invoke(api.handlerFor(PREDICT), { body: JSON.stringify({ sessionId: 's1' }) })
  assert.equal(res.statusCode, 403)
  assert.equal(jsonOf(res).error.code, 'forbidden')
  assert.equal(api.calls.predict.length, 0)
})

test('a refused admission keeps the Connection status', async () => {
  const api = makeApi({ admit: () => ({ rejection: 401 }) })
  const res = await invoke(api.handlerFor(PREFS), { body: '{}' })
  assert.equal(res.statusCode, 401)
  assert.equal(jsonOf(res).ok, false)
  assert.equal(api.calls.prefs.length, 0)
})

test('only an owner principal may use the endpoints', async () => {
  for (const admission of [{ peer: { principal: { kind: 'api' } } }, {}, { peer: {} }]) {
    const api = makeApi({ admit: () => admission })
    const res = await invoke(api.handlerFor(PREDICT), { body: JSON.stringify({ sessionId: 's1' }) })
    assert.equal(res.statusCode, 403, JSON.stringify(admission))
    assert.match(jsonOf(res).error.message, /Only the owner/)
    assert.equal(api.calls.predict.length, 0)
  }
})

test('the same-origin CSRF header is required', async () => {
  for (const headers of [{}, { [CSRF_HEADER]: '0' }, { [CSRF_HEADER]: 'true' }]) {
    const api = makeApi()
    const res = await invoke(api.handlerFor(PREDICT), { req: fakeRequest({ headers }), body: JSON.stringify({ sessionId: 's1' }) })
    assert.equal(res.statusCode, 403)
    assert.match(jsonOf(res).error.message, new RegExp(CSRF_HEADER))
    assert.equal(api.calls.predict.length, 0)
  }
})

test('the admitted headers are a Fetch-shaped bag', async () => {
  let seen
  const api = makeApi({
    admit: ({ headers }) => {
      seen = headers
      return { peer: { principal: { kind: 'owner' } } }
    },
  })
  await invoke(api.handlerFor(PREFS), {
    req: authorizedRequest({ headers: { 'x-multi': ['a', 'b'], 'x-skip': undefined, 'x-one': '1' } }),
    body: '{}',
  })
  assert.ok(seen instanceof Headers)
  assert.equal(seen.get('x-multi'), 'a, b', 'array headers are appended in order')
  assert.equal(seen.get('x-skip'), null, 'undefined headers are skipped')
  assert.equal(seen.get('x-one'), '1')
  assert.equal(seen.get(CSRF_HEADER), '1')
})

test('a malformed JSON body is a bad request', async () => {
  const api = makeApi()
  const res = await invoke(api.handlerFor(PREDICT), { body: '{nope' })
  assert.equal(res.statusCode, 400)
  assert.equal(jsonOf(res).error.code, 'bad-request')
  assert.equal(api.calls.predict.length, 0)
})

test('a JSON body that is not an object is a bad request', async () => {
  for (const body of ['[1,2]', '"suggestion"', 'null', '42']) {
    const api = makeApi()
    const res = await invoke(api.handlerFor(PREFS), { body })
    assert.equal(res.statusCode, 400, `body ${body}`)
    assert.match(jsonOf(res).error.message, /JSON object/)
    assert.equal(api.calls.prefs.length, 0)
  }
})

test('an empty body is decoded as an empty object', async () => {
  const api = makeApi()
  const res = await invoke(api.handlerFor(PREFS))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(api.calls.prefs[0].payload, {})
})

test('the request body size limit rejects oversized payloads', async () => {
  const api = makeApi()
  const req = authorizedRequest()
  const res = await invoke(api.handlerFor(PREDICT), { req, body: 'x'.repeat(16 * 1024 + 1) })
  assert.equal(res.statusCode, 400)
  assert.match(jsonOf(res).error.message, /too large/)
  assert.equal(req.destroyed, true, 'the oversized stream is torn down')
  assert.equal(api.calls.predict.length, 0)
})

test('a body stream error is reported as a bad request', async () => {
  const api = makeApi()
  const res = await invoke(api.handlerFor(PREDICT), { finish: 'error' })
  assert.equal(res.statusCode, 400)
  assert.match(jsonOf(res).error.message, /socket error/)
})

test('an aborted request body is reported as a bad request', async () => {
  const api = makeApi()
  const res = await invoke(api.handlerFor(PREDICT), { finish: 'aborted' })
  assert.equal(res.statusCode, 400)
  assert.match(jsonOf(res).error.message, /aborted/)
})

test('a successful prediction returns a 200 JSON envelope with safe headers', async () => {
  const api = makeApi()
  const res = await invoke(api.handlerFor(PREDICT), { body: JSON.stringify({ sessionId: 's1' }) })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(jsonOf(res), { ok: true, value: { enabled: true, text: '继续，把测试跑一遍' } })
  assert.deepEqual(api.calls.predict[0].payload, { sessionId: 's1' })
  assert.ok(api.calls.predict[0].signal instanceof AbortSignal, 'the handler is given a cancellation signal')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(String(res.headers['content-length']), String(Buffer.byteLength(res.body)))
})

test('a handler failure envelope is mirrored with a 400', async () => {
  const failure = { ok: false, error: { code: 'composer-prefill/bad-request', message: 'predict expects { sessionId: string }' } }
  const api = makeApi({ predict: () => failure })
  const res = await invoke(api.handlerFor(PREDICT), { body: '{}' })
  assert.equal(res.statusCode, 400)
  assert.deepEqual(jsonOf(res), failure)
})

test('a throwing handler is an internal error', async () => {
  const api = makeApi({
    predict: () => {
      throw new Error('handler exploded')
    },
  })
  const res = await invoke(api.handlerFor(PREDICT), { body: JSON.stringify({ sessionId: 's1' }) })
  assert.equal(res.statusCode, 500)
  assert.equal(jsonOf(res).error.code, 'internal')
  assert.match(jsonOf(res).error.message, /handler exploded/)
})

test('closing the request aborts the in-flight handler signal', async () => {
  const gate = deferred()
  const api = makeApi({ predict: () => gate.promise })
  const req = authorizedRequest()
  const res = fakeResponse()

  const pending = api.handlerFor(PREDICT)(req, res)
  req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's1' })))
  req.emit('end')
  await tick()

  assert.equal(api.calls.predict.length, 1)
  const signal = api.calls.predict[0].signal
  assert.equal(signal.aborted, false, 'the signal is live while the client waits')

  req.emit('close')
  assert.equal(signal.aborted, true, 'navigating away cancels the model call')

  gate.resolve({ ok: true, value: { enabled: true, text: 'kept' } })
  await pending
  assert.equal(res.statusCode, 200)
})

test('an already started response is never written twice', async () => {
  for (const mark of ['headersSent', 'writableEnded']) {
    const api = makeApi()
    const res = fakeResponse()
    res[mark] = true
    await invoke(api.handlerFor(PREDICT), { res, body: JSON.stringify({ sessionId: 's1' }) })
    assert.equal(api.calls.predict.length, 1, `${mark}: the pipeline still ran`)
    assert.equal(res.statusCode, 0, `${mark}: no second write`)
    assert.equal(res.body, '')
  }
})

test('a failure after the response started is swallowed, not thrown', async () => {
  const api = makeApi()
  const res = fakeResponse()
  res.end = () => {
    res.writableEnded = true
    throw new Error('socket closed while finishing')
  }
  const req = authorizedRequest({ method: 'GET' })
  await invoke(api.handlerFor(PREDICT), { req, res, finish: 'none' })
  assert.equal(res.statusCode, 405, 'the first write happened')
  assert.equal(res.headers.allow, 'POST')
  assert.equal(api.calls.predict.length, 0)
})

test('a route-level failure is reported as an internal error', async () => {
  const api = makeApi()
  const req = authorizedRequest()
  const originalOn = req.on.bind(req)
  req.on = (event, listener) => {
    if (event === 'close') throw new Error('cannot observe close')
    return originalOn(event, listener)
  }
  const res = await invoke(api.handlerFor(PREDICT), { req, body: JSON.stringify({ sessionId: 's1' }) })
  assert.equal(res.statusCode, 500)
  assert.equal(jsonOf(res).error.code, 'internal')
  assert.match(jsonOf(res).error.message, /cannot observe close/)
})
