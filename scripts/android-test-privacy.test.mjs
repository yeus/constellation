import assert from 'node:assert/strict'
import test from 'node:test'

import {
  redactAndroidTestError,
  summarizeAndroidNativeCrash,
  summarizeNotificationPause,
  readOptionalLogDirectory,
} from './android-test-privacy.mjs'

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

test('recognizes the stock WebView Skia glyph-mask abort without exposing the raw log', () => {
  const summary = summarizeAndroidNativeCrash(
    'SkGlyph.cpp: fatal error: Unknown mask format. private-value',
    'synthetic.application',
  )
  assert.deepEqual(summary.categories, ['skia-glyph-mask'])
  assert.equal(JSON.stringify(summary).includes('private-value'), false)
})

test('redacts a share capability from a navigation failure without losing the failure site', () => {
  const error =
    'page.goto: navigating to "http://127.0.0.1:4173/#share=syntheticSecret_42"\n at runShareFlow (test-android.mjs:1042)'
  assert.equal(
    redactAndroidTestError(error),
    'page.goto: navigating to "http://127.0.0.1:4173/#share=<redacted>"\n at runShareFlow (test-android.mjs:1042)',
  )
})

test('only a missing export directory is a pending log file', () => {
  assert.equal(
    readOptionalLogDirectory(() => {
      throw Object.assign(new Error('missing'), {
        stderr: 'ls: cache/shared-logs: No such file or directory',
      })
    }),
    '',
  )
  assert.equal(
    readOptionalLogDirectory(() => 'constellation-logs-123.txt'),
    'constellation-logs-123.txt',
  )
  assert.throws(
    () =>
      readOptionalLogDirectory(() => {
        throw new Error('device offline')
      }),
    /device offline/,
  )
})

test('notification diagnostics allowlist pause events and omit unrelated journal content', () => {
  assert.deepEqual(
    summarizeNotificationPause(
      '123 sharing.pause.request paused=true;origin=notification\n124 sharing.pause.request paused=false;origin=ui\n125 sharing.pause.request paused=true;origin=notification;secret=private\n126 unrelated private-data',
    ),
    [
      { paused: true, origin: 'notification' },
      { paused: false, origin: 'ui' },
    ],
  )
})
