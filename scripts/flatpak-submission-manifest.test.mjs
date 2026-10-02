import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { submissionManifest } from './flatpak-submission-manifest.mjs'

const localManifest = fs.readFileSync('packaging/flatpak/space.taskyon.constellation.yml', 'utf8')

test('builds a pinned Flathub review draft without build-time network or a local source', () => {
  const manifest = submissionManifest(localManifest, {
    tag: 'v0.1.0',
    commit: 'a'.repeat(40),
  })
  assert.match(manifest, /^# REVIEW DRAFT ONLY/m)
  assert.match(manifest, /must be independently re-authored by a human/i)
  assert.match(manifest, /- type: git/)
  assert.match(manifest, /tag: v0\.1\.0/)
  assert.match(manifest, new RegExp(`commit: ${'a'.repeat(40)}`))
  assert.doesNotMatch(manifest, /- type: dir/)
  assert.doesNotMatch(manifest, /build-args:/)
  assert.match(manifest, /- generated-sources\.json/)
  assert.match(manifest, /- cargo-sources\.json/)
  assert.match(manifest, /CARGO_NET_OFFLINE: 'true'/)
  assert.match(manifest, /YARN_ENABLE_NETWORK: '0'/)
})

test('rejects unpinned submissions', () => {
  assert.throws(() => submissionManifest(localManifest, { tag: 'v0.1.0', commit: 'abc' }), /commit/)
  assert.throws(
    () => submissionManifest(localManifest, { tag: 'main', commit: 'a'.repeat(40) }),
    /tag/,
  )
})
