import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WORLD_PMTILES_URL } from '../src/map/pmtilesSource.ts'

const headerLength = 127

export const probeMapSource = async (url, origin, request = fetch) => {
  const response = await request(url, {
    headers: { range: 'bytes=0-126', origin },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  try {
    if (response.status !== 206) {
      throw new Error(`HTTP ${response.status}; expected anonymous byte-range HTTP 206`)
    }
    const range = /^bytes 0-126\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    if (!range || !Number.isSafeInteger(Number(range[1])) || Number(range[1]) < headerLength) {
      throw new Error('Invalid PMTiles Content-Range')
    }
    const allowedOrigin = response.headers.get('access-control-allow-origin')
    if (allowedOrigin !== '*' && allowedOrigin !== origin) {
      throw new Error('PMTiles CORS response does not allow the application origin')
    }
    if (!response.body) throw new Error('PMTiles response has no body')
    const reader = response.body.getReader()
    const header = Buffer.alloc(headerLength)
    let offset = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (offset + value.length > headerLength) {
          throw new Error('PMTiles response must contain exactly 127 bytes')
        }
        header.set(value, offset)
        offset += value.length
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    if (offset !== headerLength) throw new Error('PMTiles response must contain exactly 127 bytes')
    if (header.toString('ascii', 0, 7) !== 'PMTiles' || header[7] !== 3) {
      throw new Error('Response is not a PMTiles v3 archive')
    }
  } finally {
    if (response.body && !response.bodyUsed && !response.body.locked) await response.body.cancel()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const origin of ['https://constellation.taskyon.space', 'http://127.0.0.1:4173']) {
      await probeMapSource(DEFAULT_WORLD_PMTILES_URL, origin)
      console.log(`Public PMTiles header and CORS verified for ${origin}.`)
    }
  } catch (error) {
    console.error(
      'Production basemap availability check failed: ' +
        (error instanceof Error ? error.message : 'request failed'),
    )
    console.error(
      'Restore anonymous read/range and CORS access to the configured world.pmtiles object; see docs/DEVELOPMENT.md.',
    )
    process.exitCode = 1
  }
}
