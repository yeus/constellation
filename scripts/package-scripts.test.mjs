import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts
const gitignore = fs.readFileSync('.gitignore', 'utf8')
const tauriConfig = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))

test('routes AppImage builds through the Nix FHS launcher', () => {
  assert.equal(scripts['build:desktop:appimage'], 'constellation-build-appimage')
  assert.equal(scripts['build:desktop:appimage:internal'], 'tauri build --bundles appimage')
})

test('uses explicit Android emulator, device, and release build paths', () => {
  assert.match(scripts['build:android:dev'], /with-android-build-tools\.sh.*x86_64/)
  assert.match(scripts['build:android:device'], /with-android-build-tools\.sh.*aarch64/)
  assert.equal(scripts['build:android:release'], 'bash scripts/build-android-release.sh')
})

test('excludes temporary Android signing properties', () => {
  assert.equal(gitignore.includes('src-tauri/gen/android/**/keystore.properties'), true)
})

test('keeps packaged frontend files separate from release artifacts', () => {
  assert.equal(tauriConfig.build.frontendDist, '../dist-tauri')
  assert.equal(gitignore.includes('dist-tauri/'), true)
})
