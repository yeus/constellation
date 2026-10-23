import assert from 'node:assert/strict'
import test from 'node:test'

import { createPmtilesCacheStorage, pmtilesCacheSourceId } from './pmtilesCacheStorage.ts'

test('reports no cache storage handle when browser storage is unavailable', async () => {
  assert.equal(await createPmtilesCacheStorage(), undefined)
})

test('derives a stable source namespace identity from the archive URL', async () => {
  const first = await pmtilesCacheSourceId('https://example.invalid/world.pmtiles')
  const second = await pmtilesCacheSourceId('https://example.invalid/world.pmtiles')
  const other = await pmtilesCacheSourceId('https://example.invalid/parcels.pmtiles')
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, second)
  assert.notEqual(first, other)
})
