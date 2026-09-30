import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('release copy rejects an APK whose signature fails verification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-apk-copy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = androidApkCandidates(root, 'release')[0]
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'synthetic unsigned APK')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const verifier = path.join(bin, 'apksigner')
  fs.writeFileSync(verifier, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  const script = fileURLToPath(new URL('./copy-android-apk.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, 'release', 'aarch64'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /signature verification failed/i)
  const destination = path.join(root, 'dist/constellation-android-release-arm64-v8a.apk')
  const checksum = `${destination}.sha256`
  assert.equal(fs.existsSync(checksum), false)
  assert.equal(fs.existsSync(destination), false)

  fs.rmSync(verifier)
  const missingVerifier = spawnSync(process.execPath, [script, 'release', 'aarch64'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: bin },
  })
  assert.notEqual(missingVerifier.status, 0)
  assert.match(missingVerifier.stderr, /apksigner is required/i)
  assert.equal(fs.existsSync(destination), false)
  assert.equal(fs.existsSync(checksum), false)

  fs.writeFileSync(verifier, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const accepted = spawnSync(process.execPath, [script, 'release', 'aarch64'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  })
  assert.equal(accepted.status, 0)
  assert.equal(fs.readFileSync(destination, 'utf8'), 'synthetic unsigned APK')
  const expectedHash = createHash('sha256').update('synthetic unsigned APK').digest('hex')
  assert.equal(
    fs.readFileSync(checksum, 'utf8'),
    `${expectedHash}  constellation-android-release-arm64-v8a.apk\n`,
  )
})
