import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const about = fs.readFileSync('src/components/AboutSheet.vue', 'utf8')
const peers = fs.readFileSync('src/components/PeerListSheet.vue', 'utf8')
const settings = fs.readFileSync('src/components/SettingsSheet.vue', 'utf8')
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
  assert.match(settings, /metered networks/i)
  assert.match(settings, /battery saver/i)
  assert.match(settings, /Data Saver/i)
  assert.match(settings, /Doze/i)
  assert.match(settings, /delay updates/i)
  assert.match(settings, /pause-when-metered/)
  assert.match(settings, /resume automatically/i)
  assert.match(peers, /connection\.share\.paused/)
  assert.match(diagnostics, /pauseReason/)
  assert.match(diagnostics, /sampling/)
})

test('active and followed location surfaces expose explicit status controls', () => {
  assert.match(peers, /connected/i)
  assert.match(peers, /precision/i)
  assert.match(peers, /expiresAt/)
  assert.match(peers, /Revoke link/)
  assert.match(peers, /statusLabel\(follow\.status\)/)
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

test('README explains direct connections, relays and encryption limits', () => {
  const readme = fs.readFileSync('README.md', 'utf8')
  assert.match(readme, /## How Constellation protects your privacy/)
  assert.match(readme, /end-to-end encrypted peer/)
  assert.match(readme, /relay for reachability/)
  assert.match(readme, /record it, or retain encrypted traffic/)
  assert.match(readme, /compromised devices/i)
  assert.match(readme, /cannot erase information already received/)
})

test('sharing separates link options from device behavior and explains encrypted delivery', () => {
  assert.doesNotMatch(shareSheet, /<legend>When to share|<legend>Update frequency/)
  assert.match(shareSheet, /Create location link/)
  assert.match(shareSheet, /End-to-end encrypted\. No central location storage\./)
  assert.match(shareSheet, /More info/)
  assert.match(settings, /every active and future link/)
  assert.match(settings, /Use while app is open/)
})
