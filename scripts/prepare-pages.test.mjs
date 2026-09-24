import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { assetLinksFor } from './prepare-pages.mjs'

test('uses only a valid Android release signing fingerprint', () => {
  const fingerprint = Array(32).fill('AB').join(':')
  const identifier = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).identifier
  assert.deepEqual(assetLinksFor(fingerprint, identifier), [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: identifier,
        sha256_cert_fingerprints: [fingerprint],
      },
    },
  ])
  assert.equal(
    assetLinksFor(fingerprint, 'org.example.synthetic')[0].target.package_name,
    'org.example.synthetic',
  )
  assert.throws(() => assetLinksFor('not a certificate', identifier), /fingerprint/i)
})
