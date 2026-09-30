import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const about = fs.readFileSync('src/components/AboutSheet.vue', 'utf8')
const shares = fs.readFileSync('src/components/ShareListSheet.vue', 'utf8')
const following = fs.readFileSync('src/components/FollowingSheet.vue', 'utf8')
const shareSheet = fs.readFileSync('src/components/ShareSheet.vue', 'utf8')

test('privacy copy states approximation, revocation and network limits', () => {
  assert.match(about, /does not make you anonymous/i)
  assert.match(about, /screenshots/i)
  assert.match(about, /colluding recipients/i)
  assert.match(about, /revocation.*future.*access/i)
  assert.match(about, /cannot erase/i)
  assert.match(about, /captive portal/i)
  assert.match(about, /blocks every available\s+outbound transport/i)
})

test('background sharing explains metered and power-policy limits', () => {
  assert.match(shareSheet, /metered networks/i)
  assert.match(shareSheet, /battery saver/i)
  assert.match(shareSheet, /Data Saver/i)
  assert.match(shareSheet, /Doze/i)
  assert.match(shareSheet, /delay\s+or\s+block/i)
})

test('active and followed location surfaces expose explicit status controls', () => {
  assert.match(shares, /connected/i)
  assert.match(shares, /precision/i)
  assert.match(shares, /expiresAt/)
  assert.match(shares, /Revoke link/)
  assert.match(following, /follow\.status/)
})
