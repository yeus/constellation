import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wrapper = path.join(projectRoot, 'scripts/with-android-build-tools.sh')

test('finds apksigner when Android build-tools versions are symlinked', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-android-build-tools-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const sdk = path.join(root, 'sdk')
  const buildTools = path.join(sdk, 'build-tools')
  const real35 = path.join(root, 'android-build-tools-35.0.0')
  const version34 = path.join(buildTools, '34.0.0')
  fs.mkdirSync(real35, { recursive: true })
  fs.mkdirSync(version34, { recursive: true })

  fs.writeFileSync(path.join(version34, 'apksigner'), '#!/bin/sh\necho wrong-version\n', {
    mode: 0o755,
  })
  fs.writeFileSync(
    path.join(real35, 'apksigner'),
    '#!/bin/sh\nprintf "symlinked-build-tools:%s\\n" "$1"\n',
    { mode: 0o755 },
  )
  fs.symlinkSync(real35, path.join(buildTools, '35.0.0'))

  const result = spawnSync('bash', [wrapper, 'apksigner', 'verified'], {
    encoding: 'utf8',
    env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: '' },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'symlinked-build-tools:verified')
})
