import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { classifyLicense, javascriptInventory } from './license-inventory.mjs'

test('classifies license families for inventory triage', () => {
  assert.equal(classifyLicense('MIT'), 'permissive')
  assert.equal(classifyLicense('MIT OR Apache-2.0'), 'permissive')
  assert.equal(classifyLicense('MIT OR Apache-2.0 OR LGPL-2.1-or-later'), 'permissive')
  assert.equal(classifyLicense('MIT AND GPL-3.0-only'), 'copyleft')
  assert.equal(classifyLicense('BSD-3-Clause'), 'permissive')
  assert.equal(classifyLicense('MPL-2.0'), 'weak-copyleft')
  assert.equal(classifyLicense('GPL-3.0-only'), 'copyleft')
  assert.equal(classifyLicense('AGPL-3.0'), 'copyleft')
  assert.equal(classifyLicense('UNLICENSED'), 'unknown')
  assert.equal(classifyLicense(undefined), 'unknown')
})

test('inventories every root production dependency even when package.json is not exported', () => {
  const rootManifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const { packages, missing } = javascriptInventory()
  const names = new Set(packages.map((pkg) => pkg.name))

  for (const dependency of Object.keys(rootManifest.dependencies ?? {})) {
    assert.ok(names.has(dependency), `${dependency} must appear in the inventory`)
  }
  for (const expected of [
    '@libp2p/crypto',
    '@libp2p/interface',
    '@multiformats/multiaddr',
    '@taskyon/p2p-core',
    '@taskyon/protocol',
    '@tauri-apps/plugin-deep-link',
    '@tauri-apps/plugin-geolocation',
  ]) {
    assert.ok(names.has(expected), `${expected} must appear in the inventory`)
  }
  assert.deepEqual(missing, [])
  assert.equal(
    new Set(packages.map((pkg) => pkg.path)).size,
    packages.length,
    'installed package roots must be unique',
  )
  assert.ok(
    packages.every((pkg) => typeof pkg.license === 'string' && pkg.license.length > 0),
    'every inventoried package must record a license',
  )
})

test('inventories installed optional production dependencies without requiring unavailable ones', () => {
  const { packages, missing } = javascriptInventory()
  const names = new Set(packages.map((pkg) => pkg.name))
  const manifest = JSON.parse(fs.readFileSync('node_modules/node-datachannel/package.json', 'utf8'))

  const installedOptional = Object.keys(manifest.optionalDependencies ?? {}).filter((name) =>
    fs.existsSync(`node_modules/${name}/package.json`),
  )
  assert.ok(installedOptional.length > 0, 'the fixture must expose an installed optional package')
  for (const dependency of installedOptional) {
    assert.ok(names.has(dependency), `${dependency} must appear in the inventory when installed`)
  }
  assert.deepEqual(missing, [])
})
