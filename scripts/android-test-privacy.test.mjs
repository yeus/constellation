import assert from 'node:assert/strict'
import test from 'node:test'

import { redactAndroidTestError, summarizeAndroidNativeCrash } from './android-test-privacy.mjs'

test('native crash summaries retain only allowlisted categories', () => {
  const logs = [
    '>>> synthetic.application <<<',
    'Chrome_InProcGp SIGABRT libwebviewchromium.so libc.so',
    'JNI DETECTED ERROR IN APPLICATION',
    'private peer: synthetic-private-peer; http://example.test/#share=syntheticSecret',
    '/private/synthetic-filename lib_private_user_file.so SIGCUSTOM',
  ].join('\n')
  assert.deepEqual(summarizeAndroidNativeCrash(logs, 'synthetic.application'), {
    appProcess: true,
    gpuThread: true,
    signals: ['SIGABRT'],
    libraries: ['libwebviewchromium.so', 'libc.so'],
    categories: ['jni-error'],
  })
  assert.equal(summarizeAndroidNativeCrash(logs, 'other.application').appProcess, false)
})

test('redacts a share capability from a navigation failure without losing the failure site', () => {
  const error =
    'page.goto: navigating to "http://127.0.0.1:4173/#share=syntheticSecret_42"\n at runShareFlow (test-android.mjs:1042)'
  assert.equal(
    redactAndroidTestError(error),
    'page.goto: navigating to "http://127.0.0.1:4173/#share=<redacted>"\n at runShareFlow (test-android.mjs:1042)',
  )
})
