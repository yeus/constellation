import assert from 'node:assert/strict'
import test from 'node:test'
import { PMTiles, zxyToTileId, type RangeResponse, type Source } from 'pmtiles'

import {
  createPmtilesArchive,
  parsePmTilesDirectory,
  parsePmtilesArchive,
  serializePmTilesDirectory,
  type PmTilesArchiveHeader,
  type PmTilesTile,
} from './format.ts'

const header: PmTilesArchiveHeader = {
  tileCompression: 1,
  tileType: 1,
  minZoom: 0,
  maxZoom: 12,
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
  centerZoom: 1,
  centerLon: 0,
  centerLat: 0,
}

class BytesSource implements Source {
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  getKey(): string {
    return 'synthetic-cache'
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const end = Math.min(this.bytes.length, offset + length)
    return { data: this.bytes.slice(offset, end).buffer }
  }
}

const tileData = (tileId: number): Uint8Array =>
  new TextEncoder().encode(`tile-${tileId}-${'x'.repeat(32)}`)

const readWithOfficialReader = async (archive: Uint8Array) => {
  const reader = new PMTiles(new BytesSource(archive))
  return { reader, header: await reader.getHeader() }
}

test('writer produces a valid archive readable by the standard PMTiles reader', async () => {
  const coordinates = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [2, 3, 1],
  ] as const
  const tiles: PmTilesTile[] = coordinates.map(([z, x, y]) => ({
    tileId: zxyToTileId(z, x, y),
    data: tileData(zxyToTileId(z, x, y)),
  }))
  const archive = createPmtilesArchive({ header, tiles, metadata: { name: 'Synthetic' } })
  const { reader, header: readHeader } = await readWithOfficialReader(archive)
  assert.equal(readHeader.minZoom, 0)
  assert.equal(readHeader.maxZoom, 12)
  assert.equal(readHeader.tileType, 1)
  assert.equal(readHeader.tileCompression, 1)
  assert.equal(readHeader.numTileEntries, tiles.length)
  for (const [index, tile] of tiles.entries()) {
    const [z, x, y] = coordinates[index]!
    const result = await reader.getZxy(z, x, y)
    assert.deepEqual(new Uint8Array(result!.data), tile.data)
  }
  assert.equal(await reader.getZxy(3, 0, 0), undefined)
  assert.deepEqual(await reader.getMetadata(), { name: 'Synthetic' })
})

test('directory serialization round-trips deltas, runs and offsets', () => {
  const entries = [
    { tileId: 5, runLength: 1, offset: 0, length: 10 },
    { tileId: 8, runLength: 2, offset: 10, length: 20 },
    { tileId: 20, runLength: 1, offset: 40, length: 30 },
  ]
  assert.deepEqual(parsePmTilesDirectory(serializePmTilesDirectory(entries)), entries)
})

test('large caches split directories into leaves that the reader can follow', async () => {
  const coordinates: [number, number, number][] = []
  const tiles: PmTilesTile[] = []
  for (let index = 0; index < 6_000; index += 1) {
    const z = 13
    const x = index % 2 ** z
    const y = Math.floor(index / 2 ** z)
    const tileId = zxyToTileId(z, x, y)
    coordinates.push([z, x, y])
    tiles.push({ tileId, data: tileData(tileId) })
  }
  const archive = createPmtilesArchive({ header: { ...header, maxZoom: 13 }, tiles })
  const { reader, header: readHeader } = await readWithOfficialReader(archive)
  assert.equal((readHeader.leafDirectoryLength ?? 0) > 0, true)
  assert.equal(readHeader.numTileEntries, tiles.length)
  for (const index of [0, 3_000, 5_999]) {
    const [z, x, y] = coordinates[index]!
    const result = await reader.getZxy(z, x, y)
    assert.deepEqual(new Uint8Array(result!.data), tiles[index]!.data)
  }
})

test('an empty cache archives remain valid', async () => {
  const archive = createPmtilesArchive({ header, tiles: [] })
  const parsed = parsePmtilesArchive(archive)
  assert.equal(parsed.tiles.size, 0)
  const { reader } = await readWithOfficialReader(archive)
  assert.equal(await reader.getZxy(0, 0, 0), undefined)
})
