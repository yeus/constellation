import assert from 'node:assert/strict'
import { test } from 'node:test'

import { androidArtifactName, androidApkCandidates } from './copy-android-apk.mjs'

test('names Android artifacts by build mode and architecture', () => {
  assert.equal(androidArtifactName('debug', 'x86_64'), 'constellation-android-debug-x86_64.apk')
  assert.equal(
    androidArtifactName('release', 'aarch64'),
    'constellation-android-release-arm64-v8a.apk',
  )
})

test('release candidates never include unsigned APKs', () => {
  const candidates = androidApkCandidates('/repo', 'release')
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every((candidate) => !candidate.endsWith('-unsigned.apk')))
})

test('debug candidates allow Tauri universal and plain outputs', () => {
  assert.deepEqual(
    androidApkCandidates('/repo', 'debug').map((candidate) => candidate.slice('/repo/'.length)),
    [
      'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk',
      'src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk',
      'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug-unsigned.apk',
      'src-tauri/gen/android/app/build/outputs/apk/debug/app-debug-unsigned.apk',
    ],
  )
})
