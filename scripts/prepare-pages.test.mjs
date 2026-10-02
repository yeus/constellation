import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assetLinksFor, preparePages, tauriIdentifier } from './prepare-pages.mjs'

const syntheticFingerprint = Array(32).fill('AB').join(':')

const createDistFixture = () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-pages-'))
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="app"></div>')
  return distDir
}

test('uses only a valid Android release signing fingerprint', () => {
  const identifier = tauriIdentifier()
  assert.deepEqual(assetLinksFor(syntheticFingerprint, identifier), [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: identifier,
        sha256_cert_fingerprints: [syntheticFingerprint],
      },
    },
  ])
  assert.equal(
    assetLinksFor(syntheticFingerprint, 'org.example.synthetic')[0].target.package_name,
    'org.example.synthetic',
  )
  assert.throws(() => assetLinksFor('not a certificate', identifier), /fingerprint/i)
})

test('prepares the SPA fallback without App Links and warns explicitly', () => {
  const distDir = createDistFixture()
  const warnings = []
  const result = preparePages({
    distDir,
    fingerprint: undefined,
    warn: (message) => warnings.push(message),
  })

  assert.equal(result.assetLinks, undefined)
  assert.deepEqual(
    fs.readFileSync(path.join(distDir, '404.html'), 'utf8'),
    fs.readFileSync(path.join(distDir, 'index.html'), 'utf8'),
  )
  assert.equal(fs.existsSync(path.join(distDir, '.well-known', 'assetlinks.json')), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ANDROID_APP_LINK_SHA256/)
})

test('prepares synthetic App Links with the Tauri identifier and exact fingerprint', () => {
  const distDir = createDistFixture()
  const result = preparePages({ distDir, fingerprint: syntheticFingerprint })
  const assetLinks = JSON.parse(
    fs.readFileSync(path.join(distDir, '.well-known', 'assetlinks.json'), 'utf8'),
  )

  assert.deepEqual(assetLinks, result.assetLinks)
  assert.deepEqual(assetLinks, assetLinksFor(syntheticFingerprint, tauriIdentifier()))
  assert.equal(assetLinks[0].target.package_name, tauriIdentifier())
  assert.deepEqual(assetLinks[0].target.sha256_cert_fingerprints, [syntheticFingerprint])
})

test('malformed fingerprints fail closed without writing App Links', () => {
  const distDir = createDistFixture()
  assert.throws(
    () => preparePages({ distDir, fingerprint: 'ab:cd', warn: () => undefined }),
    /fingerprint/i,
  )
  assert.equal(fs.existsSync(path.join(distDir, '.well-known', 'assetlinks.json')), false)
})
