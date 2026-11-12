/**
 * Unit tests for the shared configuration readers.
 *
 * Cordis can hand `apply` either plain values or live schemastery refs, so both
 * shapes are exercised here, along with every fallback the Host relies on.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig, readNumber, readString } from '../lib/config.js'

/**
 * A live schema ref, exactly as the Plugin Manager hands it over.
 *
 * @param {unknown} value the value `.get()` returns.
 * @returns {{ get: () => unknown }} stand-in ref.
 */
function ref(value) {
  return { get: () => value }
}

test('readConfig returns a plain value for a present key', () => {
  assert.equal(readConfig({ maxOutputTokens: 64 }, 'maxOutputTokens', 8), 64)
  assert.equal(readConfig({ showPredictions: false }, 'showPredictions', true), false)
  assert.deepEqual(readConfig({ nested: { a: 1 } }, 'nested', {}), { a: 1 })
})

test('readConfig falls back for a missing or nullish value', () => {
  assert.equal(readConfig({}, 'timeoutMs', 8000), 8000)
  assert.equal(readConfig({ timeoutMs: undefined }, 'timeoutMs', 8000), 8000)
  assert.equal(readConfig({ timeoutMs: null }, 'timeoutMs', 8000), 8000)
})

test('readConfig falls back when the whole config is missing', () => {
  assert.equal(readConfig(undefined, 'debug', false), false)
  assert.equal(readConfig(null, 'debug', false), false)
})

test('readConfig unwraps a live schema ref', () => {
  assert.equal(readConfig({ maxOutputTokens: ref(32) }, 'maxOutputTokens', 8), 32)
  assert.equal(readConfig({ showPredictions: ref(false) }, 'showPredictions', true), false)
})

test('readConfig falls back when a ref resolves to no value', () => {
  assert.equal(readConfig({ provider: ref(undefined) }, 'provider', 'fallback-provider'), 'fallback-provider')
  assert.equal(readConfig({ provider: ref(null) }, 'provider', 'fallback-provider'), 'fallback-provider')
})

test('readConfig keeps a plain object that is not a ref', () => {
  const plain = { reasoning: 'high' }
  assert.equal(readConfig({ model: plain }, 'model', 'fallback'), plain)
})

test('readNumber accepts finite non-negative numbers', () => {
  assert.equal(readNumber(0, 7), 0)
  assert.equal(readNumber(1500, 7), 1500)
  assert.equal(readNumber(0.5, 7), 0.5)
})

test('readNumber falls back for unusable candidates', () => {
  const fallback = 1500
  assert.equal(readNumber(-1, fallback), fallback, 'negative')
  assert.equal(readNumber(Number.NaN, fallback), fallback, 'NaN')
  assert.equal(readNumber(Number.POSITIVE_INFINITY, fallback), fallback, 'Infinity')
  assert.equal(readNumber('1500', fallback), fallback, 'numeric string')
  assert.equal(readNumber(undefined, fallback), fallback, 'undefined')
  assert.equal(readNumber(null, fallback), fallback, 'null')
  assert.equal(readNumber({}, fallback), fallback, 'object')
})

test('readString accepts only strings', () => {
  assert.equal(readString('pin', 'fallback'), 'pin')
  assert.equal(readString('', 'fallback'), '', 'an empty string is still a string')
})

test('readString falls back for non-strings', () => {
  assert.equal(readString(42, 'fallback'), 'fallback')
  assert.equal(readString(undefined, 'fallback'), 'fallback')
  assert.equal(readString(null, 'fallback'), 'fallback')
  assert.equal(readString({ get: () => 'x' }, 'fallback'), 'fallback', 'a ref is not a string until unwrapped')
})
