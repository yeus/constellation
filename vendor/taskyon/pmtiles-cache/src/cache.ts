import { zxyToTileId } from 'pmtiles'

import {
  createPmtilesArchive,
  parsePmtilesArchive,
  type PmTilesArchiveHeader,
  type PmTilesTile,
} from './format.ts'

/** A minimal staged storage port; the owner backs it with OPFS, IndexedDB or native files. */
export interface PmTilesCacheWrite {
  write: (data: Uint8Array) => Promise<void>
  commit: () => Promise<void>
  abort: () => Promise<void>
}

export interface PmTilesCacheStorage {
  read: (key: string) => Promise<Uint8Array | undefined>
  beginWrite: (key: string) => Promise<PmTilesCacheWrite>
  remove: (key: string) => Promise<void>
}

export interface PmTilesRemote {
  getHeader: () => Promise<PmTilesArchiveHeader>
  getTile: (z: number, x: number, y: number, signal?: AbortSignal) => Promise<Uint8Array | undefined>
  /** Changes when the remote archive is replaced. Defaults to no version tracking. */
  getVersion?: () => Promise<string | undefined>
  getMetadata?: () => Promise<unknown>
}

export interface PmTilesCacheOptions {
  readonly storage: PmTilesCacheStorage
  readonly key: string
  readonly remote: PmTilesRemote
  readonly maxBytes?: number
}

export interface PmTilesCacheStats {
  readonly tiles: number
  readonly bytes: number
  readonly version?: string
}

export interface PmTilesCache {
  getTile: (z: number, x: number, y: number, signal?: AbortSignal) => Promise<Uint8Array | undefined>
  clear: () => Promise<void>
  stats: () => Promise<PmTilesCacheStats>
}

type CacheEntry = { data: Uint8Array; lastAccessed: number }

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

const versionKey = (key: string): string => `${key}/version`

const totalBytes = (tiles: ReadonlyMap<number, CacheEntry>): number => {
  let total = 0
  for (const entry of tiles.values()) total += entry.data.length
  return total
}

const evict = (tiles: Map<number, CacheEntry>, maximumBytes: number): void => {
  let total = totalBytes(tiles)
  while (total > maximumBytes && tiles.size > 0) {
    let oldestId: number | undefined
    let oldestAccess = Infinity
    for (const [tileId, entry] of tiles) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed
        oldestId = tileId
      }
    }
    if (oldestId === undefined) break
    total -= tiles.get(oldestId)!.data.length
    tiles.delete(oldestId)
  }
}

const writeStaged = async (
  storage: PmTilesCacheStorage,
  key: string,
  write: (stream: PmTilesCacheWrite) => Promise<void>,
): Promise<void> => {
  const stream = await storage.beginWrite(key)
  try {
    await write(stream)
    await stream.commit()
  } catch (error) {
    await stream.abort().catch(() => undefined)
    throw error
  }
}

export const createPmtilesCache = (options: PmTilesCacheOptions): PmTilesCache => {
  const maximumBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES)
  const archiveKey = `${options.key}/archive`
  let header: PmTilesArchiveHeader | undefined
  let metadata: unknown
  let version: string | undefined
  let tiles = new Map<number, CacheEntry>()
  let initialized: Promise<void> | undefined
  let updates: Promise<void> = Promise.resolve()
  let accessCounter = 0
  const touch = (entry: CacheEntry): void => {
    entry.lastAccessed = ++accessCounter
  }

  const persist = async (next: ReadonlyMap<number, CacheEntry>): Promise<void> => {
    if (!header) return
    const archive = createPmtilesArchive({
      header,
      tiles: [...next]
        .sort(([left], [right]) => left - right)
        .map(([tileId, entry]): PmTilesTile => ({ tileId, data: entry.data })),
      metadata,
    })
    await writeStaged(options.storage, archiveKey, async (stream) => {
      await stream.write(archive)
    })
    if (version !== undefined) {
      await writeStaged(options.storage, versionKey(options.key), async (stream) => {
        await stream.write(new TextEncoder().encode(version))
      })
    }
  }

  const initialize = (): Promise<void> => {
    initialized ??= (async () => {
      header = await options.remote.getHeader()
      if (options.remote.getMetadata) {
        metadata = await options.remote.getMetadata().catch(() => undefined)
      }
      version = options.remote.getVersion ? await options.remote.getVersion() : undefined
      const storedVersion = await options.storage.read(versionKey(options.key))
      const stored = await options.storage.read(archiveKey)
      if (version !== undefined && storedVersion) {
        const previous = new TextDecoder().decode(storedVersion)
        if (previous !== version) {
          await options.storage.remove(archiveKey)
          await options.storage.remove(versionKey(options.key))
          return
        }
      }
      if (!stored) return
      try {
        const parsed = parsePmtilesArchive(stored)
        header = parsed.header
        tiles = new Map(
          [...parsed.tiles].map(([tileId, data]) => {
            const entry = { data, lastAccessed: 0 }
            touch(entry)
            return [tileId, entry]
          }),
        )
        const before = tiles.size
        evict(tiles, maximumBytes)
        if (tiles.size !== before) await persist(tiles)
      } catch {
        await options.storage.remove(archiveKey)
        await options.storage.remove(versionKey(options.key))
      }
    })()
    return initialized
  }

  const refreshVersion = async (): Promise<void> => {
    if (!options.remote.getVersion) return
    const next = await options.remote.getVersion()
    if (next === undefined || next === version) return
    tiles = new Map()
    version = next
    header = await options.remote.getHeader()
    await options.storage.remove(archiveKey)
    await options.storage.remove(versionKey(options.key))
  }

  return {
    getTile: async (z, x, y, signal) => {
      await initialize()
      await updates.catch(() => undefined)
      await refreshVersion()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!header || z < header.minZoom || z > header.maxZoom) return undefined
      const tileId = zxyToTileId(z, x, y)
      const cached = tiles.get(tileId)
      if (cached) {
        touch(cached)
        return cached.data
      }
      let resolveUpdate!: () => void
      const waiting = new Promise<void>((resolve) => {
        resolveUpdate = resolve
      })
      updates = updates.catch(() => undefined).then(() => waiting)
      try {
        const queued = tiles.get(tileId)
        if (queued) {
          touch(queued)
          return queued.data
        }
        const data = await options.remote.getTile(z, x, y, signal)
        if (!data) return undefined
        const next = new Map(tiles)
        const entry = { data, lastAccessed: 0 }
        touch(entry)
        next.set(tileId, entry)
        evict(next, maximumBytes)
        tiles = next
        try {
          await persist(next)
        } catch {
          // Cache publication is best effort; the tile still reaches the map.
        }
        return data
      } finally {
        resolveUpdate()
      }
    },
    clear: async () => {
      await initialize().catch(() => undefined)
      await updates.catch(() => undefined)
      tiles = new Map()
      version = undefined
      await options.storage.remove(archiveKey)
      await options.storage.remove(versionKey(options.key))
    },
    stats: async () => {
      await initialize().catch(() => undefined)
      await updates.catch(() => undefined)
      return {
        tiles: tiles.size,
        bytes: totalBytes(tiles),
        ...(version !== undefined ? { version } : {}),
      }
    },
  }
}
