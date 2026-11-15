import assert from 'node:assert/strict'
import test from 'node:test'

import { markerAgePresentation } from './lastKnownMarker.ts'

const peer = {
  id: 'synthetic-share',
  latitude: 10,
  longitude: -70,
  precision: 'approximate' as const,
  radiusMeters: 900,
  capturedAt: 1_000_000,
  expiresAt: 1_010_000,
  state: 'stale' as const,
}

test('offline markers fade, never disappear, and transition to a clock at two hours', () => {
  assert.deepEqual(markerAgePresentation(peer, peer.capturedAt), {
    opacity: 1,
    clockBadge: false,
    ageLabel: 'Last known · just now',
  })
  const halfway = markerAgePresentation(peer, peer.capturedAt + 60 * 60_000)
  assert.ok(halfway.opacity > 0.4 && halfway.opacity < 1)
  assert.equal(halfway.clockBadge, false)
  const old = markerAgePresentation(peer, peer.capturedAt + 2 * 60 * 60_000)
  assert.equal(old.opacity, 0.45)
  assert.equal(old.clockBadge, true)
  assert.equal(old.ageLabel, 'Last known · 2h ago')
  assert.equal(markerAgePresentation(peer, peer.capturedAt + 50 * 60 * 60_000).opacity, 0.45)
})

test('location expiry makes a marker historical even if connection status is not refreshed', () => {
  const live = { ...peer, state: 'live' as const }
  assert.equal(markerAgePresentation(live, live.capturedAt + 500).ageLabel, undefined)
  assert.equal(
    markerAgePresentation(live, live.capturedAt + 11_000).ageLabel,
    'Last known · just now',
  )
  assert.equal(
    markerAgePresentation({ ...peer, isOwn: true }, peer.capturedAt + 4 * 60 * 60_000).clockBadge,
    false,
  )
  assert.equal(
    markerAgePresentation({ ...peer, capturedAt: undefined }, 1_000_000).ageLabel,
    undefined,
  )
})
