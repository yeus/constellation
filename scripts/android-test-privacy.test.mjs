import assert from 'node:assert/strict'
import test from 'node:test'

import { redactAndroidTestError } from './android-test-privacy.mjs'

test('redacts a share capability from a navigation failure without losing the failure site', () => {
  const error =
    'page.goto: navigating to "http://127.0.0.1:4173/#share=syntheticSecret_42"\n at runShareFlow (test-android.mjs:1042)'
  assert.equal(
    redactAndroidTestError(error),
    'page.goto: navigating to "http://127.0.0.1:4173/#share=<redacted>"\n at runShareFlow (test-android.mjs:1042)',
  )
})
