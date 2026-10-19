export interface PmTilesArchiveHeader {
  readonly tileCompression: number
  readonly tileType: number
  readonly minZoom: number
  readonly maxZoom: number
  readonly minLon: number
  readonly minLat: number
  readonly maxLon: number
  readonly maxLat: number
  readonly centerZoom: number
  readonly centerLon: number
  readonly centerLat: number
}

const integerInRange = (value: number, minimum: number, maximum: number): boolean =>
  Number.isInteger(value) && value >= minimum && value <= maximum

export const parsePmTilesArchiveHeader = (value: PmTilesArchiveHeader): PmTilesArchiveHeader => {
  if (
    !integerInRange(value.tileCompression, 0, 4) ||
    !integerInRange(value.tileType, 0, 6) ||
    !integerInRange(value.minZoom, 0, 26) ||
    !integerInRange(value.maxZoom, value.minZoom, 26) ||
    !integerInRange(value.centerZoom, value.minZoom, value.maxZoom) ||
    ![value.minLon, value.minLat, value.maxLon, value.maxLat, value.centerLon, value.centerLat].every(
      Number.isFinite,
    )
  )
    throw new RangeError('Invalid PMTiles archive header.')
  return value
}

export interface PmTilesTile {
  readonly tileId: number
  readonly data: Uint8Array
}

export interface PmTilesDirectoryEntry {
  tileId: number
  runLength: number
  offset: number
  length: number
}

export interface ParsedPmTilesArchive {
  readonly header: PmTilesArchiveHeader
  readonly tiles: ReadonlyMap<number, Uint8Array>
}

const HEADER_BYTES = 127
const MAX_ROOT_DIRECTORY_BYTES = 16 * 1024
const VERSION = 3
const COMPRESSION_NONE = 1

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

const readVarint = (bytes: Uint8Array, state: { position: number }): number => {
  let result = 0
  let multiplier = 1
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[state.position++]
    if (byte === undefined) throw new Error('Unexpected end of PMTiles varint.')
    result += (byte & 0x7f) * multiplier
    if (byte < 0x80) return result
    multiplier *= 0x80
  }
  throw new Error('PMTiles varint exceeds 10 bytes.')
}

export const serializePmTilesDirectory = (
  entries: readonly PmTilesDirectoryEntry[],
): Uint8Array => {
  const bytes: number[] = [...writeVarint(entries.length)]
  let previousTileId = 0
  for (const entry of entries) {
    bytes.push(...writeVarint(entry.tileId - previousTileId))
    previousTileId = entry.tileId
  }
  for (const entry of entries) bytes.push(...writeVarint(entry.runLength))
  for (const entry of entries) bytes.push(...writeVarint(entry.length))
  let previousOffset = 0
  let previousLength = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const contiguous = index > 0 && entry.offset === previousOffset + previousLength
    bytes.push(...writeVarint(contiguous ? 0 : entry.offset + 1))
    previousOffset = entry.offset
    previousLength = entry.length
  }
  return Uint8Array.from(bytes)
}

export const parsePmTilesDirectory = (bytes: Uint8Array): PmTilesDirectoryEntry[] => {
  const state = { position: 0 }
  const count = readVarint(bytes, state)
  const entries: PmTilesDirectoryEntry[] = []
  let tileId = 0
  for (let index = 0; index < count; index += 1) {
    tileId += readVarint(bytes, state)
    entries.push({ tileId, runLength: 1, offset: 0, length: 0 })
  }
  for (const entry of entries) entry.runLength = readVarint(bytes, state)
  for (const entry of entries) entry.length = readVarint(bytes, state)
  let previousOffset = 0
  let previousLength = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const relativeOffset = readVarint(bytes, state)
    const offset = relativeOffset === 0 && index > 0 ? previousOffset + previousLength : relativeOffset - 1
    entry.offset = offset
    previousOffset = offset
    previousLength = entry.length
  }
  return entries
}

const writeUint64 = (view: DataView, offset: number, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid uint64 value.')
  view.setUint32(offset, value % 2 ** 32, true)
  view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true)
}

const readUint64 = (view: DataView, offset: number): number =>
  view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32

const writeHeader = (input: {
  header: PmTilesArchiveHeader
  rootDirectoryOffset: number
  rootDirectoryLength: number
  metadataOffset: number
  metadataLength: number
  leafDirectoryOffset: number
  leafDirectoryLength: number
  tileDataOffset: number
  tileDataLength: number
  addressedTiles: number
  tileEntries: number
  tileContents: number
}): Uint8Array => {
  const bytes = new Uint8Array(HEADER_BYTES)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('PMTiles'), 0)
  view.setUint8(7, VERSION)
  writeUint64(view, 8, input.rootDirectoryOffset)
  writeUint64(view, 16, input.rootDirectoryLength)
  writeUint64(view, 24, input.metadataOffset)
  writeUint64(view, 32, input.metadataLength)
  writeUint64(view, 40, input.leafDirectoryOffset)
  writeUint64(view, 48, input.leafDirectoryLength)
  writeUint64(view, 56, input.tileDataOffset)
  writeUint64(view, 64, input.tileDataLength)
  writeUint64(view, 72, input.addressedTiles)
  writeUint64(view, 80, input.tileEntries)
  writeUint64(view, 88, input.tileContents)
  view.setUint8(96, 1)
  view.setUint8(97, COMPRESSION_NONE)
  view.setUint8(98, input.header.tileCompression)
  view.setUint8(99, input.header.tileType)
  view.setUint8(100, input.header.minZoom)
  view.setUint8(101, input.header.maxZoom)
  view.setInt32(102, Math.round(input.header.minLon * 1e7), true)
  view.setInt32(106, Math.round(input.header.minLat * 1e7), true)
  view.setInt32(110, Math.round(input.header.maxLon * 1e7), true)
  view.setInt32(114, Math.round(input.header.maxLat * 1e7), true)
  view.setUint8(118, input.header.centerZoom)
  view.setInt32(119, Math.round(input.header.centerLon * 1e7), true)
  view.setInt32(123, Math.round(input.header.centerLat * 1e7), true)
  return bytes
}

const readHeader = (bytes: Uint8Array): {
  header: PmTilesArchiveHeader
  rootDirectoryOffset: number
  rootDirectoryLength: number
  metadataOffset: number
  metadataLength: number
  leafDirectoryOffset: number
  leafDirectoryLength: number
  tileDataOffset: number
  tileDataLength: number
} => {
  if (bytes.length < HEADER_BYTES) throw new Error('PMTiles archive is truncated.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (new TextDecoder().decode(bytes.subarray(0, 7)) !== 'PMTiles')
    throw new Error('PMTiles archive has an invalid magic prefix.')
  if (view.getUint8(7) !== VERSION) throw new Error('Unsupported PMTiles archive version.')
  if (view.getUint8(97) !== COMPRESSION_NONE)
    throw new Error('Only uncompressed PMTiles directories are supported.')
  return {
    header: {
      tileCompression: view.getUint8(98),
      tileType: view.getUint8(99),
      minZoom: view.getUint8(100),
      maxZoom: view.getUint8(101),
      minLon: view.getInt32(102, true) / 1e7,
      minLat: view.getInt32(106, true) / 1e7,
      maxLon: view.getInt32(110, true) / 1e7,
      maxLat: view.getInt32(114, true) / 1e7,
      centerZoom: view.getUint8(118),
      centerLon: view.getInt32(119, true) / 1e7,
      centerLat: view.getInt32(123, true) / 1e7,
    },
    rootDirectoryOffset: readUint64(view, 8),
    rootDirectoryLength: readUint64(view, 16),
    metadataOffset: readUint64(view, 24),
    metadataLength: readUint64(view, 32),
    leafDirectoryOffset: readUint64(view, 40),
    leafDirectoryLength: readUint64(view, 48),
    tileDataOffset: readUint64(view, 56),
    tileDataLength: readUint64(view, 64),
  }
}

const splitDirectories = (
  entries: readonly PmTilesDirectoryEntry[],
): { root: PmTilesDirectoryEntry[]; leaves: Uint8Array[] } => {
  const allBytes = serializePmTilesDirectory(entries)
  if (allBytes.length <= MAX_ROOT_DIRECTORY_BYTES) return { root: [...entries], leaves: [] }
  const leaves: Uint8Array[] = []
  const root: PmTilesDirectoryEntry[] = []
  let pending: PmTilesDirectoryEntry[] = []
  let leafOffset = 0
  const flush = (): void => {
    if (!pending.length) return
    const leaf = serializePmTilesDirectory(pending)
    leaves.push(leaf)
    root.push({
      tileId: pending[0]!.tileId,
      runLength: 0,
      offset: leafOffset,
      length: leaf.length,
    })
    leafOffset += leaf.length
    pending = []
  }
  for (const entry of entries) {
    const candidate = [...pending, entry]
    if (pending.length && serializePmTilesDirectory(candidate).length > MAX_ROOT_DIRECTORY_BYTES) {
      flush()
    }
    pending.push(entry)
  }
  flush()
  return { root, leaves }
}

const readDirectory = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): PmTilesDirectoryEntry[] =>
  parsePmTilesDirectory(bytes.subarray(offset, offset + length))

export const createPmtilesArchive = (input: {
  header: PmTilesArchiveHeader
  tiles: readonly PmTilesTile[]
  metadata?: unknown
}): Uint8Array => {
  const header = parsePmTilesArchiveHeader(input.header)
  const sorted = [...input.tiles].sort((left, right) => left.tileId - right.tileId)
  const entries: PmTilesDirectoryEntry[] = []
  let tileOffset = 0
  for (let index = 0; index < sorted.length; index += 1) {
    const tile = sorted[index]!
    if (index > 0 && sorted[index - 1]!.tileId === tile.tileId)
      throw new Error('PMTiles cache contains duplicate tile ids.')
    entries.push({
      tileId: tile.tileId,
      runLength: 1,
      offset: tileOffset,
      length: tile.data.length,
    })
    tileOffset += tile.data.length
  }
  const { root, leaves } = splitDirectories(entries)
  const rootBytes = serializePmTilesDirectory(root)
  const leafBytes = new Uint8Array(leaves.reduce((sum, leaf) => sum + leaf.length, 0))
  let leafCursor = 0
  for (const leaf of leaves) {
    leafBytes.set(leaf, leafCursor)
    leafCursor += leaf.length
  }
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify(input.metadata ?? {}),
  )
  const rootDirectoryOffset = HEADER_BYTES
  const metadataOffset = rootDirectoryOffset + rootBytes.length
  const leafDirectoryOffset = metadataOffset + metadataBytes.length
  const tileDataOffset = leafDirectoryOffset + leafBytes.length
  const tileData = new Uint8Array(tileOffset)
  let dataCursor = 0
  for (const tile of sorted) {
    tileData.set(tile.data, dataCursor)
    dataCursor += tile.data.length
  }
  const headerBytes = writeHeader({
    header,
    rootDirectoryOffset,
    rootDirectoryLength: rootBytes.length,
    metadataOffset,
    metadataLength: metadataBytes.length,
    leafDirectoryOffset,
    leafDirectoryLength: leafBytes.length,
    tileDataOffset,
    tileDataLength: tileData.length,
    addressedTiles: sorted.length,
    tileEntries: entries.length,
    tileContents: sorted.length,
  })
  const archive = new Uint8Array(
    HEADER_BYTES + rootBytes.length + metadataBytes.length + leafBytes.length + tileData.length,
  )
  let cursor = 0
  for (const part of [headerBytes, rootBytes, metadataBytes, leafBytes, tileData]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}

export const parsePmtilesArchive = (bytes: Uint8Array): ParsedPmTilesArchive => {
  const parsed = readHeader(bytes)
  const root = readDirectory(
    bytes,
    parsed.rootDirectoryOffset,
    parsed.rootDirectoryLength,
  )
  const tiles = new Map<number, Uint8Array>()
  for (const entry of root) {
    const entries =
      entry.runLength === 0
        ? readDirectory(
            bytes,
            parsed.leafDirectoryOffset + entry.offset,
            entry.length,
          )
        : [entry]
    for (const tileEntry of entries) {
      tiles.set(
        tileEntry.tileId,
        bytes.slice(
          parsed.tileDataOffset + tileEntry.offset,
          parsed.tileDataOffset + tileEntry.offset + tileEntry.length,
        ),
      )
    }
  }
  return { header: parsed.header, tiles }
}
