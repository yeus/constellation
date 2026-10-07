import assert from 'node:assert/strict'
import test from 'node:test'

import { createMapPresentation } from './mapPresentation.ts'
import type { MapLocation } from './mapModel.ts'

const settings = {
  enabled: true,
  groupMarkerCollisions: true,
  groupUncertaintyOverlap: true,
  uncertaintyOverlapThreshold: 0.9,
  markerCollisionDistancePx: 18,
}

const projected = (location: MapLocation, x: number, y: number, uncertaintyRadiusPx = 0) => ({
  location,
  x,
  y,
  uncertaintyRadiusPx,
})

test('groups colliding peer markers and keeps own location independent', () => {
  const own: MapLocation = {
    id: 'own',
    isOwn: true,
    latitude: 0,
    longitude: 0,
    precision: 'exact',
  }
  const first: MapLocation = {
    id: 'first',
    label: 'River',
    latitude: 0,
    longitude: 0,
    precision: 'exact',
  }
  const second: MapLocation = {
    id: 'second',
    label: 'Forest',
    latitude: 0,
    longitude: 0,
    precision: 'exact',
  }

  const presentation = createMapPresentation(
    [projected(own, 50, 50), projected(first, 100, 100), projected(second, 112, 100)],
    { width: 300, height: 200 },
    settings,
  )

  assert.deepEqual(
    presentation.groups.map(({ members }) => members.map(({ id }) => id)),
    [['first', 'second']],
  )
  assert.deepEqual(
    presentation.mapLocations.map(({ id }) => id),
    ['own'],
  )
  assert.equal(presentation.groups[0]?.x, 106)
  assert.ok((presentation.groups[0]?.radiusPx ?? 0) >= settings.markerCollisionDistancePx / 2)
})

test('groups strongly overlapping uncertainty disks and encloses each member disk', () => {
  const first: MapLocation = {
    id: 'first',
    latitude: 0,
    longitude: 0,
    precision: 'approximate',
    radiusMeters: 1_000,
  }
  const second: MapLocation = {
    id: 'second',
    latitude: 0,
    longitude: 0,
    precision: 'approximate',
    radiusMeters: 1_000,
  }
  const items = [projected(first, 100, 100, 100), projected(second, 105, 100, 100)]
  const presentation = createMapPresentation(
    items,
    { width: 300, height: 200 },
    { ...settings, groupMarkerCollisions: false },
  )
  const group = presentation.groups[0]

  assert.equal(group?.members.length, 2)
  assert.ok(group)
  for (const item of items) {
    assert.ok(
      Math.hypot(item.x - group.x, item.y - group.y) + item.uncertaintyRadiusPx <= group.radiusPx,
    )
  }
})

test('keeps weakly overlapping disks separate and honors independent grouping controls', () => {
  const first: MapLocation = {
    id: 'first',
    latitude: 0,
    longitude: 0,
    precision: 'approximate',
    radiusMeters: 1_000,
  }
  const second = { ...first, id: 'second' }
  const items = [projected(first, 100, 100, 100), projected(second, 150, 100, 100)]

  assert.equal(createMapPresentation(items, { width: 300, height: 200 }, settings).groups.length, 0)
  assert.equal(
    createMapPresentation(
      items,
      { width: 300, height: 200 },
      {
        ...settings,
        groupUncertaintyOverlap: false,
      },
    ).groups.length,
    0,
  )
  assert.equal(
    createMapPresentation(
      [projected(first, 100, 100), projected(second, 112, 100)],
      {
        width: 300,
        height: 200,
      },
      { ...settings, groupMarkerCollisions: false },
    ).groups.length,
    0,
  )
})

test('moves only visible oversized uncertainty regions into the peer panel', () => {
  const visible: MapLocation = {
    id: 'visible',
    label: 'Near',
    latitude: 0,
    longitude: 0,
    precision: 'approximate',
    radiusMeters: 1_000,
  }
  const offscreen = { ...visible, id: 'offscreen', label: 'Far' }

  const presentation = createMapPresentation(
    [projected(visible, 80, 50, 100), projected(offscreen, 500, 50, 100)],
    { width: 100, height: 100 },
    settings,
  )

  assert.deepEqual(
    presentation.largePeers.map(({ id }) => id),
    ['visible'],
  )
  assert.deepEqual(
    presentation.mapLocations.map(({ id }) => id),
    ['offscreen'],
  )
})

test('rejects invalid viewport and grouping thresholds', () => {
  const location: MapLocation = {
    id: 'peer',
    latitude: 0,
    longitude: 0,
    precision: 'exact',
  }
  assert.throws(() =>
    createMapPresentation([projected(location, 0, 0)], { width: 0, height: 100 }, settings),
  )
  assert.throws(() =>
    createMapPresentation(
      [projected(location, 0, 0)],
      { width: 100, height: 100 },
      { ...settings, uncertaintyOverlapThreshold: 1.1 },
    ),
  )
})
