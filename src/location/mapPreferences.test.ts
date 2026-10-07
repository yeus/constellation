import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MAP_DECLUTTERING_PREFERENCES,
  loadMapDeclutteringPreferences,
  saveMapDeclutteringPreferences,
} from './mapPreferences.ts'

const createStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  }
}

test('uses safe defaults when no local map preferences have been saved', () => {
  assert.deepEqual(loadMapDeclutteringPreferences(createStorage()), {
    ...DEFAULT_MAP_DECLUTTERING_PREFERENCES,
  })
})

test('saves and restores independent local grouping controls', () => {
  const storage = createStorage()
  const preferences = {
    enabled: false,
    groupMarkerCollisions: true,
    groupUncertaintyOverlap: false,
    uncertaintyOverlapThreshold: 0.75,
    markerCollisionDistancePx: 30,
  }

  saveMapDeclutteringPreferences(storage, preferences)

  assert.deepEqual(loadMapDeclutteringPreferences(storage), preferences)
})

test('ignores malformed or out-of-range stored values', () => {
  const storage = createStorage()
  storage.setItem(
    'constellation.map-decluttering',
    JSON.stringify({
      enabled: true,
      groupMarkerCollisions: false,
      groupUncertaintyOverlap: true,
      uncertaintyOverlapThreshold: 2,
      markerCollisionDistancePx: -10,
    }),
  )

  assert.deepEqual(loadMapDeclutteringPreferences(storage), {
    ...DEFAULT_MAP_DECLUTTERING_PREFERENCES,
    groupMarkerCollisions: false,
  })
  storage.setItem('constellation.map-decluttering', '{broken')
  assert.deepEqual(loadMapDeclutteringPreferences(storage), {
    ...DEFAULT_MAP_DECLUTTERING_PREFERENCES,
  })
})
