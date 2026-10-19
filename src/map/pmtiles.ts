import { layers, namedFlavor } from '@protomaps/basemaps'
import { addProtocol, removeProtocol, setWorkerUrl } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { PMTiles, tileTypeExt, type Header } from 'pmtiles'

import {
  createPmtilesCache,
  type PmTilesArchiveHeader,
  type PmTilesCache,
} from '@taskyon/pmtiles-cache'

import {
  createPmtilesCacheStorage,
  type PmtilesCacheBackend,
  type PmtilesCacheStorageHandle,
} from './pmtilesCacheStorage.ts'

export const DEFAULT_WORLD_PMTILES_URL =
  'https://eu2.contabostorage.com/af09f5440e00407ca6d2d275a4a4dc89:protomaps/world.pmtiles'

export type MapFamily = 'default' | 'minimalist'
export type MapTheme = 'light' | 'dark'

export const MAP_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · ' +
  '<a href="https://github.com/protomaps/basemaps">Protomaps</a> · ' +
  '<a href="https://esa-worldcover.org/en">ESA WorldCover</a>'

export const mapFlavor = (family: MapFamily, theme: MapTheme): string =>
  family === 'default' ? theme : theme === 'dark' ? 'black' : 'grayscale'

export const createWorldStyle = (
  url: string,
  family: MapFamily,
  theme: MapTheme,
): StyleSpecification => {
  const flavor = mapFlavor(family, theme)
  const assets = new URL(`${import.meta.env.BASE_URL}map-assets/`, window.location.origin)
  return {
    version: 8,
    sprite: new URL(`sprites/v4/${flavor}`, assets).toString(),
    sources: {
      world: {
        type: 'vector',
        url: `pmtiles://${url}`,
        attribution: MAP_ATTRIBUTION,
      },
    },
    layers: layers('world', namedFlavor(flavor), { lang: 'en' }),
  }
}

const createMapLibreWorkerBootstrapUrl = (): string => {
  const compatibilityUrl = new URL(
    `${import.meta.env.BASE_URL}legacy-compat.js`,
    window.location.origin,
  ).toString()
  const compiledWorkerUrl = new URL(mapLibreWorkerUrl, window.location.origin).toString()
  return URL.createObjectURL(
    new Blob(
      [
        `import ${JSON.stringify(compatibilityUrl)};`,
        `import ${JSON.stringify(compiledWorkerUrl)};`,
      ],
      { type: 'text/javascript' },
    ),
  )
}

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024
const PMTILES_PREFIX = 'pmtiles://'
const TILE_URL = /^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)/

export interface PmtilesCacheStats {
  readonly backend?: PmtilesCacheBackend
  readonly archives: number
  readonly tiles: number
  readonly bytes: number
}

export interface PmtilesRuntimeOptions {
  readonly maxBytes?: number
}

const cacheHeader = (header: Header): PmTilesArchiveHeader => ({
  tileCompression: header.tileCompression,
  tileType: header.tileType,
  minZoom: header.minZoom,
  maxZoom: header.maxZoom,
  minLon: header.minLon,
  minLat: header.minLat,
  maxLon: header.maxLon,
  maxLat: header.maxLat,
  centerZoom: header.centerZoom,
  centerLon: header.centerLon,
  centerLat: header.centerLat,
})

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

export const createPmtilesRuntime = (options: PmtilesRuntimeOptions = {}) => {
  let installed = false
  let workerBootstrapUrl: string | undefined
  let maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_CACHE_BYTES)
  let storageHandle: PmtilesCacheStorageHandle | undefined
  let storagePromise: Promise<void> | undefined
  const archives = new Map<
    string,
    { reader: PMTiles; cache?: PmTilesCache; ready: Promise<void> }
  >()

  const ensureStorage = async (): Promise<void> => {
    storagePromise ??= createPmtilesCacheStorage()
      .then((handle) => {
        storageHandle = handle
      })
      .catch(() => undefined)
    await storagePromise
  }

  const createCache = (url: string, reader: PMTiles): PmTilesCache | undefined => {
    if (!storageHandle || maxBytes <= 0) return undefined
    return createPmtilesCache({
      storage: storageHandle.storage,
      key: url,
      maxBytes,
      remote: {
        getHeader: async () => cacheHeader(await reader.getHeader()),
        getMetadata: () => reader.getMetadata(),
        getVersion: async () => (await reader.getHeader()).etag,
        getTile: async (z, x, y, signal) => {
          const tile = await reader.getZxy(z, x, y, signal)
          return tile ? new Uint8Array(tile.data) : undefined
        },
      },
    })
  }

  const handleRequest: Parameters<typeof addProtocol>[1] = async (params, abortController) => {
    if (params.type === 'json') {
      const archiveUrl = params.url.startsWith(PMTILES_PREFIX)
        ? params.url.slice(PMTILES_PREFIX.length)
        : undefined
      const entry = archiveUrl ? archives.get(archiveUrl) : undefined
      if (!entry) throw new Error('Unknown PMTiles archive.')
      const header = await entry.reader.getHeader()
      const metadata = metadataRecord(await entry.reader.getMetadata())
      return {
        data: {
          tilejson: '3.0.0',
          scheme: 'xyz',
          tiles: [`${PMTILES_PREFIX}${archiveUrl}/{z}/{x}/{y}${tileTypeExt(header.tileType)}`],
          vector_layers: metadata.vector_layers,
          attribution: metadata.attribution,
          description: metadata.description,
          name: metadata.name,
          version: metadata.version,
          bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
          center: [header.centerLon, header.centerLat, header.centerZoom],
          minzoom: header.minZoom,
          maxzoom: header.maxZoom,
        },
      }
    }
    const match = TILE_URL.exec(params.url)
    if (!match) throw new Error('Invalid PMTiles tile URL.')
    const [, archiveUrl, z, x, y] = match
    const entry = archives.get(archiveUrl!)
    if (!entry) throw new Error('Unknown PMTiles archive.')
    await entry.ready
    const tile = entry.cache
      ? await entry.cache
          .getTile(Number(z), Number(x), Number(y), abortController.signal)
          .catch(() => undefined)
      : undefined
    const data =
      tile ??
      (await entry.reader.getZxy(Number(z), Number(x), Number(y), abortController.signal))?.data
    return { data: data ? new Uint8Array(data) : new Uint8Array(0) }
  }

  return {
    setup: (): void => {
      if (installed) return
      workerBootstrapUrl = createMapLibreWorkerBootstrapUrl()
      setWorkerUrl(workerBootstrapUrl)
      addProtocol('pmtiles', handleRequest)
      installed = true
    },
    verifyArchive: async (url: string): Promise<void> => {
      const reader = new PMTiles(url)
      const entry: { reader: PMTiles; cache?: PmTilesCache; ready: Promise<void> } = {
        reader,
        ready: Promise.resolve(),
      }
      entry.ready = (async () => {
        await reader.getHeader()
        await reader.getMetadata()
        await ensureStorage()
        entry.cache = createCache(url, reader)
      })()
      archives.set(url, entry)
      await entry.ready
    },
    cacheStats: async (): Promise<PmtilesCacheStats> => {
      await storagePromise?.catch(() => undefined)
      const stats = await Promise.all(
        [...archives.values()].map(async (entry) =>
          entry.cache ? await entry.cache.stats() : undefined,
        ),
      )
      const active = stats.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      )
      return {
        ...(storageHandle ? { backend: storageHandle.backend } : {}),
        archives: active.length,
        tiles: active.reduce((total, entry) => total + entry.tiles, 0),
        bytes: active.reduce((total, entry) => total + entry.bytes, 0),
      }
    },
    clearCache: async (): Promise<void> => {
      await Promise.all([...archives.values()].map(async (entry) => await entry.cache?.clear()))
    },
    setCacheMaxBytes: (next: number): void => {
      maxBytes = Math.max(0, next)
      for (const [url, entry] of archives) entry.cache = createCache(url, entry.reader)
    },
    dispose: (): void => {
      if (!installed) return
      removeProtocol('pmtiles')
      if (workerBootstrapUrl) URL.revokeObjectURL(workerBootstrapUrl)
      workerBootstrapUrl = undefined
      archives.clear()
      installed = false
    },
  }
}
