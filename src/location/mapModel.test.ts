import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLocationFeatureCollection,
  locationAreaBounds,
  locationObservationToMapLocation,
  locationsBounds,
} from './mapModel.ts'
import { LOCATION_PROFILE_V1 } from './locationObservation.ts'

test('renders GPS accuracy and approximate areas without center markers', () => {
  const features = createLocationFeatureCollection([
    {
      id: 'exact',
      latitude: 52.52,
      longitude: 13.405,
      precision: 'exact',
      accuracyMeters: 12,
      state: 'live',
    },
    {
      id: 'approximate',
      latitude: 48.137,
      longitude: 11.575,
      precision: 'approximate',
      radiusMeters: 500,
      state: 'stale',
    },
  ])

  assert.equal(features.features.length, 2)
  assert.equal(features.features[0]?.geometry.type, 'Polygon')
  assert.equal(features.features[0]?.properties?.shape, 'accuracy')
  assert.equal(features.features[1]?.geometry.type, 'Polygon')
  assert.equal(features.features[1]?.properties?.shape, 'approximate')
})

test('keeps source-owned disclosure precision when adapting observations', () => {
  const observation = {
    profile: LOCATION_PROFILE_V1,
    sourceId: 'synthetic-source',
    precision: 'approximate',
    sequence: 1,
    capturedAt: 1_000,
    expiresAt: 31_000,
    latitude: 40,
    longitude: -70,
    accuracyMeters: 800,
  } as const

  assert.deepEqual(locationObservationToMapLocation(observation), {
    id: 'synthetic-source',
    latitude: 40,
    longitude: -70,
    precision: 'approximate',
    radiusMeters: 800,
    state: 'live',
  })
})

test('represents approximate locations only with their uncertainty area', () => {
  const location = {
    id: 'synthetic-area',
    latitude: 40,
    longitude: 20,
    precision: 'approximate' as const,
    radiusMeters: 500,
  }

  const feature = createLocationFeatureCollection([location]).features[0]
  assert.equal(feature?.geometry.type, 'Polygon')
  assert.equal(feature?.properties?.shape, 'approximate')
})

test('switches an own approximate area to a point only when it is smaller than the marker', () => {
  const location = {
    id: 'synthetic-area',
    isOwn: true,
    latitude: 40,
    longitude: 20,
    precision: 'approximate' as const,
    radiusMeters: 500,
  }

  const far = createLocationFeatureCollection([location], 8).features
  const near = createLocationFeatureCollection([location], 13).features

  assert.equal(far.length, 1)
  assert.equal(far[0]?.geometry.type, 'Point')
  assert.equal(far[0]?.properties?.shape, 'approximate')
  assert.equal(near.length, 1)
  assert.equal(near[0]?.geometry.type, 'Polygon')
})

test('uses the same zoom-dependent fallback for a GPS accuracy area', () => {
  const location = {
    id: 'synthetic-own-position',
    isOwn: true,
    latitude: 40,
    longitude: 20,
    precision: 'exact' as const,
    accuracyMeters: 20,
  }

  const far = createLocationFeatureCollection([location], 8).features[0]
  const near = createLocationFeatureCollection([location], 17).features[0]

  assert.equal(far?.geometry.type, 'Point')
  assert.equal(far?.properties?.shape, 'accuracy')
  assert.equal(near?.geometry.type, 'Polygon')
})

test('switches received areas to points when they are smaller than the marker', () => {
  const features = createLocationFeatureCollection(
    [
      {
        id: 'peer-approximate',
        latitude: 40,
        longitude: 20,
        precision: 'approximate',
        radiusMeters: 500,
      },
      { id: 'peer-exact', latitude: 40, longitude: 20, precision: 'exact', accuracyMeters: 20 },
    ],
    8,
  ).features

  assert.deepEqual(
    features.map(({ geometry }) => geometry.type),
    ['Point', 'Point'],
  )
})

test('provides bounds around the full uncertainty area', () => {
  const bounds = locationAreaBounds({
    id: 'synthetic-area',
    latitude: 40,
    longitude: 20,
    precision: 'approximate',
    radiusMeters: 1_000,
  })

  assert.ok(bounds)
  assert.ok(bounds[0][0] < 20 && bounds[1][0] > 20)
  assert.ok(bounds[0][1] < 40 && bounds[1][1] > 40)
})

test('frames several peer areas together across the date line', () => {
  const bounds = locationsBounds([
    { id: 'east', latitude: 10, longitude: 179.8, precision: 'approximate', radiusMeters: 500 },
    { id: 'west', latitude: 11, longitude: -179.8, precision: 'approximate', radiusMeters: 500 },
  ])

  assert.ok(bounds)
  assert.ok(bounds[1][0] - bounds[0][0] < 2)
  assert.ok(bounds[0][1] < 10 && bounds[1][1] > 11)
  assert.equal(locationsBounds([]), undefined)
})

test('rejects invalid coordinates and uncertainty radii', () => {
  assert.throws(() =>
    createLocationFeatureCollection([
      { id: 'invalid', latitude: 91, longitude: 0, precision: 'exact' },
    ]),
  )
  assert.throws(() =>
    createLocationFeatureCollection([
      {
        id: 'invalid-radius',
        latitude: 0,
        longitude: 0,
        precision: 'approximate',
        radiusMeters: 0,
      },
    ]),
  )
})

test('carries owner and peer colors into exact points and approximate areas', () => {
  const features = createLocationFeatureCollection([
    { id: 'own', latitude: 1, longitude: 2, precision: 'exact', color: '#f78f3b' },
    {
      id: 'peer',
      latitude: 3,
      longitude: 4,
      precision: 'approximate',
      radiusMeters: 400,
      color: '#438ec9',
    },
  ])

  assert.equal(features.features[0]?.properties?.color, '#f78f3b')
  assert.equal(features.features[1]?.properties?.color, '#438ec9')
})

test('own and followed locations share the same threshold and retain color and stale state', () => {
  const peer = {
    id: 'synthetic-peer',
    latitude: 40,
    longitude: 20,
    precision: 'approximate' as const,
    radiusMeters: 500,
    color: '#289a82',
    state: 'stale' as const,
  }
  for (const zoom of [8, 13, 8]) {
    const features = createLocationFeatureCollection(
      [peer, { ...peer, id: 'synthetic-own', isOwn: true }],
      zoom,
    ).features
    assert.equal(features.length, 2)
    assert.equal(features[0]?.geometry.type, features[1]?.geometry.type)
    for (const feature of features) {
      assert.equal(feature.properties.color, peer.color)
      assert.equal(feature.properties.state, 'stale')
    }
  }
})
