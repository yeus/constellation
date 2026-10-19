import assert from 'node:assert/strict'
import test from 'node:test'
import { PMTiles, zxyToTileId, type RangeResponse, type Source } from 'pmtiles'

import {
  createPmtilesCache,
  type PmTilesCacheStorage,
  type PmTilesCacheWrite,
} from './cache.ts'
import type { PmTilesArchiveHeader } from './format.ts'

const header: PmTilesArchiveHeader = {
  tileCompression: 1,
  tileType: 1,
  minZoom: 0,
  maxZoom: 14,
  minLon: -180,
  minLat: -85,
  maxLon: 180,
  maxLat: 85,
  centerZoom: 1,
  centerLon: 0,
  centerLat: 0,
}

class MemoryStorage implements PmTilesCacheStorage {
  readonly values = new Map<string, Uint8Array>()
  async read(key: string): Promise<Uint8Array | undefined> {
    return this.values.get(key)?.slice()
  }
  async beginWrite(key: string): Promise<PmTilesCacheWrite> {
    let chunks: Uint8Array[] = []
    return {
      write: async (data) => {
        chunks.push(data.slice())
      },
      commit: async () => {
        const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) {
          total.set(chunk, offset)
          offset += chunk.length
        }
        this.values.set(key, total)
      },
      abort: async () => {
        chunks = []
      },
    }
  }
  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }
}

class BytesSource implements Source {
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  getKey(): string {
    return 'cached'
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: this.bytes.slice(offset, offset + length).buffer }
  }
}

const tileBytes = (z: number, x: number, y: number): Uint8Array =>
  new TextEncoder().encode(`tile:${z}/${x}/${y}:${'d'.repeat(16)}`)

const createRemote = (options?: {
  version?: string
  tiles?: ReadonlySet<string>
}) => {
  const calls: string[] = []
  let version = options?.version
  return {
    calls,
    setVersion: (next: string | undefined) => {
      version = next
    },
    remote: {
      getHeader: async () => header,
      getTile: async (z: number, x: number, y: number) => {
        const key = `${z}/${x}/${y}`
        if (options?.tiles && !options.tiles.has(key)) return undefined
        calls.push(key)
        return tileBytes(z, x, y)
      },
      getVersion: async () => version,
    },
  }
}

const readArchive = async (storage: MemoryStorage, key: string) => {
  const bytes = await storage.read(`${key}/archive`)
  if (!bytes) return undefined
  const reader = new PMTiles(new BytesSource(bytes))
  return {
    reader,
    header: await reader.getHeader(),
  }
}

test('serves misses from the remote and later hits from the persisted cache', async () => {
  const storage = new MemoryStorage()
  const { calls, remote } = createRemote({ version: 'v1' })
  const cache = createPmtilesCache({ storage, key: 'world', remote })
  const first = await cache.getTile(1, 0, 0)
  const second = await cache.getTile(1, 0, 0)
  assert.deepEqual(first, tileBytes(1, 0, 0))
  assert.deepEqual(second, first)
  assert.deepEqual(calls, ['1/0/0'])
  assert.deepEqual((await cache.stats()), { tiles: 1, bytes: tileBytes(1, 0, 0).length, version: 'v1' })

  const archive = await readArchive(storage, 'world')
  assert.ok(archive)
  const cached = await archive.reader.getZxy(1, 0, 0)
  assert.deepEqual(new Uint8Array(cached!.data), tileBytes(1, 0, 0))

  const restored = createPmtilesCache({ storage, key: 'world', remote })
  assert.deepEqual(await restored.getTile(1, 0, 0), first)
  assert.deepEqual(calls, ['1/0/0'])
})

test('evicts the least recently used tile and keeps the archive valid', async () => {
  const storage = new MemoryStorage()
  const { remote } = createRemote()
  const cache = createPmtilesCache({ storage, key: 'bounded', remote, maxBytes: 60 })
  await cache.getTile(1, 0, 0)
  await cache.getTile(1, 1, 0)
  await cache.getTile(1, 0, 0)
  await cache.getTile(1, 0, 1)
  assert.equal((await cache.stats()).tiles, 2)
  const archive = await readArchive(storage, 'bounded')
  assert.ok(archive)
  assert.ok(await archive.reader.getZxy(1, 0, 0))
  assert.equal(await archive.reader.getZxy(1, 1, 0), undefined)
  assert.ok(await archive.reader.getZxy(1, 0, 1))
})

test('invalidates the cache when the remote version changes', async () => {
  const storage = new MemoryStorage()
  const { calls, remote, setVersion } = createRemote({ version: 'v1' })
  const cache = createPmtilesCache({ storage, key: 'versioned', remote })
  await cache.getTile(1, 0, 0)
  assert.deepEqual(calls, ['1/0/0'])
  setVersion('v2')
  assert.deepEqual(await cache.getTile(1, 0, 0), tileBytes(1, 0, 0))
  assert.deepEqual(calls, ['1/0/0', '1/0/0'])
  assert.equal(new TextDecoder().decode(await storage.read('versioned/version')), 'v2')
})

test('serializes concurrent misses without losing either tile', async () => {
  const storage = new MemoryStorage()
  const { remote } = createRemote()
  const cache = createPmtilesCache({ storage, key: 'concurrent', remote })
  const [first, second] = await Promise.all([cache.getTile(1, 0, 0), cache.getTile(1, 1, 0)])
  assert.deepEqual(first, tileBytes(1, 0, 0))
  assert.deepEqual(second, tileBytes(1, 1, 0))
  assert.equal((await cache.stats()).tiles, 2)
  const archive = await readArchive(storage, 'concurrent')
  assert.ok(archive)
  assert.ok(await archive.reader.getZxy(1, 0, 0))
  assert.ok(await archive.reader.getZxy(1, 1, 0))
})

test('cache clear removes both the archive and its version', async () => {
  const storage = new MemoryStorage()
  const { calls, remote } = createRemote({ version: 'v1' })
  const cache = createPmtilesCache({ storage, key: 'clear', remote })
  await cache.getTile(1, 0, 0)
  await cache.clear()
  assert.equal(await storage.read('clear/archive'), undefined)
  assert.equal(await storage.read('clear/version'), undefined)
  const restored = createPmtilesCache({ storage, key: 'clear', remote })
  await restored.getTile(1, 0, 0)
  assert.deepEqual(calls, ['1/0/0', '1/0/0'])
})

test('cache misses outside the remote zoom range are not stored', async () => {
  const storage = new MemoryStorage()
  const { calls, remote } = createRemote()
  const cache = createPmtilesCache({ storage, key: 'range', remote })
  assert.equal(await cache.getTile(20, 0, 0), undefined)
  assert.deepEqual(calls, [])
  assert.equal(zxyToTileId(1, 0, 0) >= 0, true)
})
