import { layers, namedFlavor } from '@protomaps/basemaps'
import { addProtocol, removeProtocol, setWorkerUrl } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { PMTiles, tileTypeExt, type Source } from 'pmtiles'

import {
  createPmtilesCachedSource,
  createPmtilesHttpSource,
  type PmtilesCachedSource,
} from '@taskyon/pmtiles-cache'

import {
  createPmtilesCacheStorage,
  pmtilesCacheSourceId,
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
  readonly packs: number
  readonly windows: number
  readonly bytes: number
}

export interface PmtilesRuntimeOptions {
  readonly maxBytes?: number
}

const metadataRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

interface PmtilesArchiveEntry {
  reader: PMTiles
  readonly source: Source
  cache?: PmtilesCachedSource
  ready: Promise<void>
}

interface PmtilesRuntimeState {
  installed: boolean
  workerBootstrapUrl?: string
  maxBytes: number
  storageHandle?: PmtilesCacheStorageHandle
  storagePromise?: Promise<void>
  rebuildChain: Promise<void>
  readonly archives: Map<string, PmtilesArchiveEntry>
  readonly pendingArchives: Map<string, Promise<PmtilesArchiveEntry>>
}

const createRuntimeState = (options: PmtilesRuntimeOptions): PmtilesRuntimeState => ({
  installed: false,
  maxBytes: Math.max(0, options.maxBytes ?? DEFAULT_CACHE_BYTES),
  rebuildChain: Promise.resolve(),
  archives: new Map(),
  pendingArchives: new Map(),
})

const ensureStorage = async (state: PmtilesRuntimeState): Promise<void> => {
  state.storagePromise ??= createPmtilesCacheStorage()
    .then((handle) => {
      state.storageHandle = handle
    })
    .catch(() => undefined)
  await state.storagePromise
}

const createArchiveEntry = async (
  state: PmtilesRuntimeState,
  url: string,
): Promise<PmtilesArchiveEntry> => {
  const remote = createPmtilesHttpSource({ url })
  let cache: PmtilesCachedSource | undefined
  if (state.storageHandle) {
    const sourceId = await pmtilesCacheSourceId(url)
    cache = createPmtilesCachedSource({
      storage: state.storageHandle.storage,
      namespace: `pmtiles/${sourceId}`,
      sourceKey: url,
      remote,
      maxBytes: state.maxBytes,
      onError: (error) => {
        console.warn('Map cache storage unavailable; keeping the online map usable.', error)
      },
    })
  }
  const source = cache ?? remote
  const entry: PmtilesArchiveEntry = {
    reader: new PMTiles(source),
    source,
    ...(cache ? { cache } : {}),
    ready: Promise.resolve(),
  }
  entry.ready = entry.reader.getHeader().then(() => undefined)
  return entry
}

const resetReader = (entry: PmtilesArchiveEntry): void => {
  entry.reader = new PMTiles(entry.source)
}

const tileJsonResponse = async (entry: PmtilesArchiveEntry, archiveUrl: string) => {
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

const resolveArchive = async (
  state: PmtilesRuntimeState,
  archiveUrl: string,
): Promise<PmtilesArchiveEntry> => {
  const entry = state.archives.get(archiveUrl)
  if (entry) return entry
  const pending = state.pendingArchives.get(archiveUrl)
  if (pending) return await pending
  throw new Error('Unknown PMTiles archive.')
}

const handleJsonRequest = async (state: PmtilesRuntimeState, url: string) => {
  const archiveUrl = url.startsWith(PMTILES_PREFIX) ? url.slice(PMTILES_PREFIX.length) : undefined
  if (!archiveUrl) throw new Error('Invalid PMTiles archive URL.')
  const entry = await resolveArchive(state, archiveUrl)
  await entry.ready
  try {
    return await tileJsonResponse(entry, archiveUrl)
  } catch (error) {
    resetReader(entry)
    throw error
  }
}

const readTile = async (
  state: PmtilesRuntimeState,
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const match = TILE_URL.exec(url)
  if (!match) throw new Error('Invalid PMTiles tile URL.')
  const [, archiveUrl, z, x, y] = match
  const entry = await resolveArchive(state, archiveUrl!)
  await entry.ready
  try {
    const tile = await entry.reader.getZxy(Number(z), Number(x), Number(y), signal)
    return tile ? new Uint8Array(tile.data) : new Uint8Array(0)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) resetReader(entry)
    throw error
  }
}

const createProtocolHandler = (state: PmtilesRuntimeState): Parameters<typeof addProtocol>[1] => {
  return async (params, abortController) => {
    if (params.type === 'json') return handleJsonRequest(state, params.url)
    return { data: await readTile(state, params.url, abortController.signal) }
  }
}

const setupRuntime = (state: PmtilesRuntimeState): void => {
  if (state.installed) return
  state.workerBootstrapUrl = createMapLibreWorkerBootstrapUrl()
  setWorkerUrl(state.workerBootstrapUrl)
  addProtocol('pmtiles', createProtocolHandler(state))
  state.installed = true
}

const createArchive = async (
  state: PmtilesRuntimeState,
  url: string,
): Promise<PmtilesArchiveEntry> => {
  await ensureStorage(state)
  return await createArchiveEntry(state, url)
}

const verifyRuntimeArchive = async (state: PmtilesRuntimeState, url: string): Promise<void> => {
  const pending = createArchive(state, url)
  state.pendingArchives.set(url, pending)
  let entry: PmtilesArchiveEntry
  try {
    entry = await pending
  } finally {
    state.pendingArchives.delete(url)
  }
  state.archives.set(url, entry)
  try {
    await entry.ready
  } catch (error) {
    resetReader(entry)
    entry.ready = Promise.resolve()
    throw error
  }
}

const cacheStatsFor = async (state: PmtilesRuntimeState): Promise<PmtilesCacheStats> => {
  await state.storagePromise?.catch(() => undefined)
  await state.rebuildChain.catch(() => undefined)
  const stats = await Promise.all(
    [...state.archives.values()].map(async (entry) =>
      entry.cache ? await entry.cache.stats() : undefined,
    ),
  )
  const active = stats.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  return {
    ...(state.storageHandle ? { backend: state.storageHandle.backend } : {}),
    archives: active.length,
    packs: active.reduce((total, entry) => total + entry.packs, 0),
    windows: active.reduce((total, entry) => total + entry.windows, 0),
    bytes: active.reduce((total, entry) => total + entry.bytes, 0),
  }
}

const clearRuntimeCache = async (state: PmtilesRuntimeState): Promise<void> => {
  await state.rebuildChain.catch(() => undefined)
  await Promise.all([...state.archives.values()].map(async (entry) => await entry.cache?.clear()))
}

const rebuildArchive = async (
  state: PmtilesRuntimeState,
  url: string,
  previous: PmtilesArchiveEntry,
): Promise<void> => {
  await previous.cache?.close()
  const next = await createArchive(state, url)
  state.archives.set(url, next)
  await next.ready.catch(() => undefined)
}

const setRuntimeCacheMaxBytes = (state: PmtilesRuntimeState, next: number): void => {
  state.maxBytes = Math.max(0, next)
  for (const [url, entry] of state.archives) {
    state.rebuildChain = state.rebuildChain
      .then(() => rebuildArchive(state, url, entry))
      .catch(() => undefined)
  }
}

const disposeRuntime = (state: PmtilesRuntimeState): void => {
  if (!state.installed) return
  removeProtocol('pmtiles')
  if (state.workerBootstrapUrl) URL.revokeObjectURL(state.workerBootstrapUrl)
  state.workerBootstrapUrl = undefined
  for (const entry of state.archives.values()) void entry.cache?.close()
  state.archives.clear()
  state.pendingArchives.clear()
  state.installed = false
}

export const createPmtilesRuntime = (options: PmtilesRuntimeOptions = {}) => {
  const state = createRuntimeState(options)
  return {
    setup: () => setupRuntime(state),
    verifyArchive: (url: string) => verifyRuntimeArchive(state, url),
    cacheStats: () => cacheStatsFor(state),
    clearCache: () => clearRuntimeCache(state),
    setCacheMaxBytes: (next: number) => setRuntimeCacheMaxBytes(state, next),
    dispose: () => disposeRuntime(state),
  }
}
