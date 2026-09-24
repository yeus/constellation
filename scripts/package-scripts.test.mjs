import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts
const gitignore = fs.readFileSync('.gitignore', 'utf8')
const tauriConfig = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))

test('names distributable builds by platform, mode, and target', () => {
  assert.equal(scripts['build:desktop:release:appimage'], 'constellation-build-release-appimage')
  assert.equal(scripts['build:desktop:release:appimage:internal'], 'tauri build --bundles appimage')
  assert.equal(scripts['build:desktop:release:flatpak'], 'bash scripts/build-flatpak.sh')
  assert.match(
    scripts['build:android:debug:x86_64-emulator'],
    /with-android-build-tools\.sh.*--debug --apk --target x86_64/,
  )
  assert.match(
    scripts['build:android:debug:arm64-device'],
    /with-android-build-tools\.sh.*--debug --apk --target aarch64/,
  )
  assert.equal(
    scripts['build:android:release:arm64-device'],
    'bash scripts/build-android-release.sh',
  )
  assert.equal(scripts['build:android:release'], 'yarn build:android:release:arm64-device')
  assert.match(
    scripts['build:android:background-runtime'],
    /vite build --config vite\.background\.config\.ts/,
  )
  for (const oldName of [
    'build:desktop:appimage',
    'build:desktop:appimage:internal',
    'build:desktop:flatpak',
    'build:android:runtime',
    'build:android:dev',
    'build:android:device',
  ]) {
    assert.equal(scripts[oldName], undefined, `${oldName} should be replaced by a clearer name`)
  }
})

test('excludes temporary Android signing properties', () => {
  assert.equal(gitignore.includes('src-tauri/gen/android/**/keystore.properties'), true)
})

test('keeps packaged frontend files separate from release artifacts', () => {
  assert.equal(tauriConfig.build.frontendDist, '../dist-tauri')
  assert.equal(gitignore.includes('dist-tauri/'), true)
})
