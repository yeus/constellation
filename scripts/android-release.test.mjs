import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('does not overwrite an existing local Android keystore.properties', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-android-release-test-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  const scriptPath = path.join(fixtureRoot, 'scripts/build-android-release.sh')
  const generatedAppDir = path.join(fixtureRoot, 'src-tauri/gen/android/app')
  const keystorePath = path.join(fixtureRoot, 'release-test.jks')
  const propertiesPath = path.join(generatedAppDir, 'keystore.properties')
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.mkdirSync(generatedAppDir, { recursive: true })
  fs.copyFileSync(path.join(projectRoot, 'scripts/build-android-release.sh'), scriptPath)
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/android-release-secrets.sh'),
    path.join(fixtureRoot, 'scripts/android-release-secrets.sh'),
  )
  fs.writeFileSync(path.join(generatedAppDir, 'build.gradle.kts'), 'plugins {}\n')
  fs.writeFileSync(keystorePath, 'synthetic keystore')
  fs.writeFileSync(propertiesPath, 'preserve this local configuration\n')

  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ANDROID_KEYSTORE_PATH: keystorePath,
      ANDROID_KEYSTORE_PASSWORD: 'synthetic-store-password',
      ANDROID_KEY_ALIAS: 'synthetic-alias',
      ANDROID_KEY_PASSWORD: 'synthetic-key-password',
    },
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /keystore\.properties.*already exists/i)
  assert.equal(fs.readFileSync(propertiesPath, 'utf8'), 'preserve this local configuration\n')
})
