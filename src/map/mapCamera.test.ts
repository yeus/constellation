import assert from 'node:assert/strict'
import test from 'node:test'
import { isDefaultMapCamera, MapCameraSchema } from './mapCamera.ts'

test('accepts a valid last-viewed camera without limiting usable zoom levels', () => {
  assert.deepEqual(MapCameraSchema.parse({ longitude: -117.16, latitude: 32.72, zoom: 20 }), {
    longitude: -117.16,
    latitude: 32.72,
    zoom: 20,
  })
  assert.equal(isDefaultMapCamera({ longitude: 0, latitude: 20, zoom: 1.5 }), true)
})
test('rejects impossible and nonfinite coordinates or zooms', () => {
  for (const value of [
    { longitude: 181, latitude: 0, zoom: 9 },
    { longitude: 0, latitude: 90, zoom: 9 },
    { longitude: 0, latitude: 0, zoom: Number.NaN },
  ]) {
    assert.equal(MapCameraSchema.safeParse(value).success, false)
  }
})
