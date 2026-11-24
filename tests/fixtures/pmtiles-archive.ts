import type { Page } from '@playwright/test'

// Minimal PMTiles v3 archive with one valid MVT tile and an empty vector layer.
// The tile starts beyond the initial 16 KiB header/root read, so the renderer
// must issue a separate byte-range request for the actual tile.
const createArchive = () => {
  const metadata = Buffer.from(JSON.stringify({ name: 'Synthetic world', vector_layers: [] }))
  const tile = Buffer.from([0x1a, 9, 0x0a, 2, 0x65, 0x6d, 0x78, 2, 0x28, 0x80, 0x20])
  const root = Buffer.from([1, 0, 1, tile.length, 1])
  const header = Buffer.alloc(127)
  header.write('PMTiles', 0)
  header[7] = 3
  const metadataOffset = header.length + root.length
  const tileOffset = 16_384
  const fields: [number, number][] = [
    [8, header.length],
    [16, root.length],
    [24, metadataOffset],
    [32, metadata.length],
    [40, tileOffset],
    [56, tileOffset],
    [64, tile.length],
    [72, 1],
    [80, 1],
    [88, 1],
  ]
  for (const [offset, value] of fields) header.writeBigUInt64LE(BigInt(value), offset)
  header[96] = 1 // clustered
  header[97] = 1 // no internal compression
  header[98] = 1 // no tile compression
  header[99] = 1 // MVT
  header.writeInt32LE(-1800000000, 102)
  header.writeInt32LE(-850000000, 106)
  header.writeInt32LE(1800000000, 110)
  header.writeInt32LE(850000000, 114)
  return Buffer.concat([
    header,
    root,
    metadata,
    Buffer.alloc(tileOffset - metadataOffset - metadata.length),
    tile,
  ])
}

export const serveSyntheticPmtiles = async (page: Page) => {
  const archive = createArchive()
  let tileRequests = 0
  await page.route('**/*.pmtiles', async (route) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '')
    if (!range) throw new Error('Expected a PMTiles byte-range request')
    const start = Number(range[1])
    const end = Number(range[2])
    if (start < 0 || end < start || end >= archive.length) {
      throw new Error('PMTiles fixture received an out-of-bounds range')
    }
    if (start >= 16_384) tileRequests += 1
    await route.fulfill({
      status: 206,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'Content-Range, ETag',
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${archive.length}`,
        etag: '"synthetic-pmtiles-v1"',
      },
      body: archive.subarray(start, end + 1),
    })
  })
  return () => tileRequests
}
