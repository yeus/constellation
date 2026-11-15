import assert from 'node:assert/strict'
import test from 'node:test'

import { offscreenPeerRank, offscreenRailCapacity, rankOffscreenPeers } from './offscreenPeers.ts'
import type { MapLocation } from './mapModel.ts'

const peer = (id: string, longitude: number, radiusMeters = 0): MapLocation => ({
  id,
  latitude: 0,
  longitude,
  precision: 'approximate',
  radiusMeters,
})
const projected = (location: MapLocation, x: number, y = 50) => ({
  location,
  x,
  y,
  uncertaintyRadiusPx: 0,
})
const viewport = { width: 200, height: 100 }
const center = { latitude: 0, longitude: 0 }

test('off-screen rail ranks distance plus uncertainty rather than center distance alone', () => {
  const nearImprecise = peer('near-imprecise', 0.1, 100_000)
  const farPrecise = peer('far-precise', 0.5, 500)
  const nearest = peer('nearest', 0.05, 0)
  const items = [projected(nearImprecise, -10), projected(farPrecise, 300), projected(nearest, 250)]
  assert.deepEqual(
    rankOffscreenPeers(items, viewport, center).map(({ id }) => id),
    ['nearest', 'far-precise', 'near-imprecise'],
  )
  assert.ok(offscreenPeerRank(center, nearImprecise) > offscreenPeerRank(center, farPrecise))
})

test('off-screen rail excludes local and on-screen locations and already represented peers', () => {
  const visible = peer('visible', 0.1)
  const hidden = peer('hidden', 0.2)
  const local = { ...peer('local', 0.3), isOwn: true }
  const areaStacked = peer('area-stacked', 0.4)
  const selectedGroup = peer('selected-group', 0.5)
  const list = rankOffscreenPeers(
    [
      projected(visible, 50),
      projected(hidden, -2),
      projected(local, 300),
      projected(areaStacked, 300),
      projected(selectedGroup, -2),
    ],
    viewport,
    center,
    new Set(['area-stacked', 'selected-group']),
  )
  assert.deepEqual(
    list.map(({ id }) => id),
    ['hidden'],
  )
})

test('rank uses actual accuracy for exact locations and handles dateline and ties', () => {
  const acrossDateline = {
    ...peer('across', -179.9),
    precision: 'exact' as const,
    accuracyMeters: 5,
  }
  const distant = peer('distant', 175, 0)
  const longitudeCenter = { latitude: 0, longitude: 179.9 }
  assert.ok(
    offscreenPeerRank(longitudeCenter, acrossDateline) <
      offscreenPeerRank(longitudeCenter, distant),
  )
  const equalA = peer('a', 0.2)
  const equalB = peer('b', -0.2)
  assert.deepEqual(
    rankOffscreenPeers([projected(equalB, -1), projected(equalA, 201)], viewport, center).map(
      ({ id }) => id,
    ),
    ['a', 'b'],
  )
})

test('missing uncertainty sorts after measured peers, never as an exact zero-radius fix', () => {
  const unknown = { ...peer('unknown', 0.05), radiusMeters: undefined }
  const precise = peer('precise', 0.5, 10)
  assert.deepEqual(
    rankOffscreenPeers([projected(unknown, -2), projected(precise, 205)], viewport, center).map(
      ({ id }) => id,
    ),
    ['precise', 'unknown'],
  )
  assert.equal(offscreenPeerRank(center, unknown), Infinity)
})

test('rail capacity obeys 50% map height, avatar size, top controls and bottom stack', () => {
  assert.equal(offscreenRailCapacity(640, 20), 6)
  assert.equal(offscreenRailCapacity(360, 20), 3)
  assert.equal(offscreenRailCapacity(360, 160), 2)
  assert.equal(offscreenRailCapacity(150, 20), 0)
  assert.equal(offscreenRailCapacity(640, 310), 4)
})
