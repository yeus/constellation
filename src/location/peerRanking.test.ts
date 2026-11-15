import assert from 'node:assert/strict'
import test from 'node:test'

import { proximityScoreMeters, rankPeersByProximity } from './peerRanking.ts'
import type { MapLocation } from './mapModel.ts'

const own: MapLocation = {
  id: 'own',
  isOwn: true,
  latitude: 32.72,
  longitude: -117.16,
  precision: 'exact',
  accuracyMeters: 12,
}
const location = (
  id: string,
  offsetDegrees: number,
  radiusMeters?: number,
  precision: MapLocation['precision'] = 'approximate',
): MapLocation => ({
  id,
  latitude: own.latitude + offsetDegrees,
  longitude: own.longitude,
  precision,
  ...(radiusMeters === undefined
    ? {}
    : precision === 'exact'
      ? { accuracyMeters: radiusMeters }
      : { radiusMeters }),
})
const peer = (name: string, ...shareIds: string[]) => ({
  key: name,
  name,
  following: shareIds.map((shareId) => ({ shareId })),
})

test('penalizes a huge uncertainty area even for a nearly colocated peer', () => {
  const nearImprecise = location('near', 0.0001, 2_000)
  const fartherPrecise = location('far', 0.003, 10, 'exact')
  const sorted = rankPeersByProximity(
    [peer('A near', 'near'), peer('Z precise', 'far')],
    [own, nearImprecise, fartherPrecise],
  )
  assert.deepEqual(
    sorted.map(({ name }) => name),
    ['Z precise', 'A near'],
  )
  assert.ok(
    (proximityScoreMeters(own, nearImprecise) ?? 0) >
      (proximityScoreMeters(own, fartherPrecise) ?? Infinity),
  )
})

test('uses real geodesic distance and accepts an exact location accuracy radius', () => {
  const nearby = location('near', 0.001, 5, 'exact')
  const distant = location('distant', 0.04, 5, 'exact')
  const sorted = rankPeersByProximity(
    [peer('A distant', 'distant'), peer('Z nearby', 'near')],
    [own, distant, nearby],
  )
  assert.deepEqual(
    sorted.map(({ key }) => key),
    ['Z nearby', 'A distant'],
  )
})

test('places missing, invalid or undisclosed accuracy after rankable peers', () => {
  const unknown = location('unknown', 0.00001)
  const invalid = location('invalid', 0.00001, Number.POSITIVE_INFINITY)
  const known = location('known', 0.03, 50)
  const peers = [
    peer('Alpha no location', 'absent'),
    peer('Beta unknown', 'unknown'),
    peer('Gamma invalid', 'invalid'),
    peer('Zulu known', 'known'),
  ]
  const sorted = rankPeersByProximity(peers, [own, known, unknown, invalid])
  assert.deepEqual(
    sorted.map(({ name }) => name),
    ['Zulu known', 'Alpha no location', 'Beta unknown', 'Gamma invalid'],
  )
  assert.equal(proximityScoreMeters(own, unknown), undefined)
  assert.equal(proximityScoreMeters(own, invalid), undefined)
})

test('uses the best currently received link and preserves the source array', () => {
  const peers = [peer('Alpha', 'coarse', 'accurate'), peer('Beta', 'middle')]
  const sorted = rankPeersByProximity(peers, [
    own,
    location('coarse', 0, 20_000),
    location('accurate', 0.001, 12),
    location('middle', 0.01, 15),
  ])
  assert.deepEqual(
    sorted.map(({ name }) => name),
    ['Alpha', 'Beta'],
  )
  assert.deepEqual(
    peers.map(({ name }) => name),
    ['Alpha', 'Beta'],
  )
})

test('falls back to deterministic alphabetical ordering without our position', () => {
  const peers = [peer('Zara', 'near'), peer('Alice', 'far')]
  const sorted = rankPeersByProximity(peers, [location('near', 0, 2), location('far', 0.2, 10)])
  assert.deepEqual(
    sorted.map(({ name }) => name),
    ['Alice', 'Zara'],
  )
})

test('treats antimeridian neighbors as close and breaks equal scores by name', () => {
  const atDateLine: MapLocation = { ...own, longitude: 179.99 }
  const across: MapLocation = { ...location('across', 0, 10), longitude: -179.99 }
  const far: MapLocation = { ...location('far', 0, 10), longitude: 175 }
  const sorted = rankPeersByProximity(
    [peer('Far', 'far'), peer('Near', 'across'), peer('Amy', 'across')],
    [atDateLine, across, far],
  )
  assert.deepEqual(
    sorted.map(({ name }) => name),
    ['Amy', 'Near', 'Far'],
  )
})
