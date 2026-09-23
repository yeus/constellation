import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocationFeatureCollection, locationObservationToMapLocation } from './mapModel.ts'
import { LOCATION_PROFILE_V1 } from './locationObservation.ts'

test('renders exact positions and approximate areas', () => {
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

  assert.equal(features.features.length, 3)
  assert.equal(features.features[0]?.geometry.type, 'Point')
  assert.equal(features.features[1]?.geometry.type, 'Polygon')
  assert.equal(features.features[2]?.geometry.type, 'Polygon')
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
