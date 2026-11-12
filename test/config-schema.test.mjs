/**
 * Schema-contract regression for the Settings → General switch.
 *
 * The browser half writes `showPredictions` through DSH's shared settings
 * document (`configForms`). `@deepseek-ai/dsh-settings` only exposes a namespace
 * when the plugin Config has a `.volatile()` field, so a non-volatile master
 * switch renders a switch that looks alive (optimistic `aria-checked`) but every
 * write is rejected and the choice never reaches the Host. The real-browser e2e
 * caught exactly that; this unit test keeps the schema contract pinned without
 * booting a Host.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../index.js'

test('the master switch is volatile so the settings document can write it', () => {
  assert.equal(Config.dict.showPredictions.meta.volatile, true)
})

test('the remaining tunables stay ordinary profile configuration', () => {
  for (const key of Object.keys(Config.dict)) {
    if (key === 'showPredictions') continue
    assert.notEqual(Config.dict[key].meta.volatile, true, `${key} must not be volatile`)
  }
})
