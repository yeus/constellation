import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appImageInventory,
  classifyBundledLibrary,
  defaultApkPath,
  flatpakInputs,
  strictArtifactIssues,
} from './artifact-license-inventory.mjs'

test('classifies known bundled platform libraries by obligation family', () => {
  assert.deepEqual(classifyBundledLibrary('libwebkit2gtk-4.1.so.0'), {
    component: 'WebKitGTK / JavaScriptCore',
    family: 'LGPL-2.1-or-later',
  })
  assert.equal(classifyBundledLibrary('libgtk-3.so.0')?.family, 'LGPL-2.1-or-later')
  assert.equal(classifyBundledLibrary('libX11.so.6')?.family, 'MIT')
  assert.equal(classifyBundledLibrary('libnss3.so')?.family, 'MPL-2.0')
  assert.equal(classifyBundledLibrary('libconstellation_lib.so'), undefined)
})

test('reads Flatpak runtime, module, and source inputs', () => {
  const inputs = flatpakInputs('packaging/flatpak/space.taskyon.constellation.yml')
  assert.equal(inputs.runtime, 'org.gnome.Platform')
  assert.equal(inputs.sdk, 'org.gnome.Sdk')
  assert.ok(inputs.modules.includes('constellation'))
  assert.equal(inputs.localSource, true)
  assert.equal(inputs.networkBuildArgs, false)
})

test('classifies an extracted AppImage payload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-appimage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'usr', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'usr', 'lib', 'libgtk-3.so.0'), '')
  fs.writeFileSync(path.join(root, 'usr', 'lib', 'libcustom.so'), '')
  const libraries = appImageInventory(root)
  assert.equal(libraries.length, 2)
  assert.equal(
    libraries.find((library) => library.name === 'libgtk-3.so.0')?.family,
    'LGPL-2.1-or-later',
  )
  assert.equal(libraries.find((library) => library.name === 'libcustom.so')?.family, 'unknown')
})

test('selects the newest APK from dist with its directory preserved', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-artifacts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'dist', 'a.apk'), '')
  fs.writeFileSync(path.join(root, 'dist', 'b.apk'), '')

  assert.equal(defaultApkPath(root), path.join(root, 'dist', 'b.apk'))
})

test('strict artifact review fails when an APK or AppImage payload was not inspected', () => {
  assert.deepEqual(strictArtifactIssues({ flatpak: {} }), [
    'No Android APK was inspected.',
    'No AppImage payload was inspected; pass --appimage-root <extracted-root>.',
  ])
  assert.deepEqual(
    strictArtifactIssues({
      apk: {},
      appImage: { libraries: [{ name: 'libcustom.so', family: 'unknown' }] },
      flatpak: {},
    }),
    ['1 bundled AppImage library needs license review: libcustom.so'],
  )
})
