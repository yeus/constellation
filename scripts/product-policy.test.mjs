import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const about = fs.readFileSync('src/components/AboutSheet.vue', 'utf8')
const shares = fs.readFileSync('src/components/ShareListSheet.vue', 'utf8')
const following = fs.readFileSync('src/components/FollowingSheet.vue', 'utf8')
const shareSheet = fs.readFileSync('src/components/ShareSheet.vue', 'utf8')
const diagnostics = fs.readFileSync('src/components/NetworkDiagnosticsSheet.vue', 'utf8')

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
  assert.match(shareSheet, /pause-when-metered/)
  assert.match(shareSheet, /resumes\s+automatically/i)
  assert.match(shares, /pauseReason/)
  assert.match(diagnostics, /pauseReason/)
  assert.match(diagnostics, /sampling/)
})

test('active and followed location surfaces expose explicit status controls', () => {
  assert.match(shares, /connected/i)
  assert.match(shares, /precision/i)
  assert.match(shares, /expiresAt/)
  assert.match(shares, /Revoke link/)
  assert.match(following, /follow\.status/)
})

test('0.1 includes field fixes, uniform markers and executable sharing diagnostics', () => {
  const catalog = fs.readFileSync(new URL('../SYSTEM_DEFINITION.csv', import.meta.url), 'utf8')
  for (const id of [
    'share-back-individual',
    'share-back-group-approval',
    'share-lifecycle-history',
    'transient-status-notices',
    'android-background-share-status',
    'diagnostics-sharing-suite',
  ]) {
    const row = catalog.split('\n').find((line) => line.startsWith(`${id},`))
    assert.ok(row, `${id} is missing from the catalog`)
    assert.ok(row.endsWith(',0.1'), `${id} must target 0.1`)
  }
  const mapRow = catalog.split('\n').find((line) => line.startsWith('maplibre-component,'))
  assert.match(mapRow, /own and followed/)
})
