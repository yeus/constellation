import { zxyToTileId } from 'pmtiles'

const HEADER_BYTES = 127
const VERSION = 3
const COMPRESSION_NONE = 1
const TILE_TYPE_MVT = 1

const writeVarint = (value: number): number[] => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid varint value.')
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) | 0x80)
    remaining = Math.floor(remaining / 0x80)
  }
  bytes.push(remaining)
  return bytes
}

const serializeDirectory = (
  entries: readonly { tileId: number; offset: number; length: number }[],
): Uint8Array => {
  const bytes: number[] = [...writeVarint(entries.length)]
  let previousTileId = 0
  for (const entry of entries) {
    bytes.push(...writeVarint(entry.tileId - previousTileId))
    previousTileId = entry.tileId
  }
  entries.forEach(() => bytes.push(...writeVarint(1)))
  for (const entry of entries) bytes.push(...writeVarint(entry.length))
  let previousOffset = 0
  let previousLength = 0
  entries.forEach((entry, index) => {
    const contiguous = index > 0 && entry.offset === previousOffset + previousLength
    bytes.push(...writeVarint(contiguous ? 0 : entry.offset + 1))
    previousOffset = entry.offset
    previousLength = entry.length
  })
  return Uint8Array.from(bytes)
}

const writeUint64 = (view: DataView, offset: number, value: number): void => {
  view.setUint32(offset, value % 2 ** 32, true)
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true)
}

export interface TestArchiveTile {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly data: Uint8Array
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    total.set(part, offset)
    offset += part.byteLength
  }
  return total
}

/** Build a small but valid spec-v3 archive (large enough for a 16 KiB header read). */
export const createTestArchive = (tiles: readonly TestArchiveTile[]): Uint8Array => {
  const sorted = [...tiles].sort(
    (left, right) => zxyToTileId(left.z, left.x, left.y) - zxyToTileId(right.z, right.x, right.y),
  )
  const entries = sorted.map(({ z, x, y, data }) => ({
    tileId: zxyToTileId(z, x, y),
    offset: 0,
    length: data.byteLength,
    data,
  }))
  let tileOffset = 0
  for (const entry of entries) {
    entry.offset = tileOffset
    tileOffset += entry.length
  }
  const root = serializeDirectory(entries)
  const metadata = new TextEncoder().encode(JSON.stringify({ name: 'test-world' }))
  const tileData = concat(entries.map((entry) => entry.data))
  const rootOffset = HEADER_BYTES
  const metadataOffset = rootOffset + root.byteLength
  const tileDataOffset = metadataOffset + metadata.byteLength

  const header = new Uint8Array(HEADER_BYTES)
  const view = new DataView(header.buffer)
  header.set(new TextEncoder().encode('PMTiles'), 0)
  view.setUint8(7, VERSION)
  writeUint64(view, 8, rootOffset)
  writeUint64(view, 16, root.byteLength)
  writeUint64(view, 24, metadataOffset)
  writeUint64(view, 32, metadata.byteLength)
  writeUint64(view, 40, 0)
  writeUint64(view, 48, 0)
  writeUint64(view, 56, tileDataOffset)
  writeUint64(view, 64, tileData.byteLength)
  writeUint64(view, 72, entries.length)
  writeUint64(view, 80, entries.length)
  writeUint64(view, 88, entries.length)
  view.setUint8(96, 1)
  view.setUint8(97, COMPRESSION_NONE)
  view.setUint8(98, COMPRESSION_NONE)
  view.setUint8(99, TILE_TYPE_MVT)
  view.setUint8(100, 0)
  view.setUint8(101, 2)
  view.setInt32(102, -180 * 1e7, true)
  view.setInt32(106, -85 * 1e7, true)
  view.setInt32(110, 180 * 1e7, true)
  view.setInt32(114, 85 * 1e7, true)
  view.setUint8(118, 0)
  view.setInt32(119, 0, true)
  view.setInt32(123, 0, true)
  return concat([header, root, metadata, tileData])
}

export const createTestTiles = (): TestArchiveTile[] => [
  { z: 0, x: 0, y: 0, data: new Uint8Array(6_000).fill(1) },
  { z: 1, x: 0, y: 0, data: new Uint8Array(6_000).fill(2) },
  { z: 2, x: 0, y: 0, data: new Uint8Array(6_000).fill(3) },
]
