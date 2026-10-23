import type { TaskyonTestFn } from '@taskyon/diagnostics'
import { createPmtilesCachedSource, type PmtilesCachedSource } from '@taskyon/pmtiles-cache'
import type { RangeResponse, Source } from 'pmtiles'

import {
  createPmtilesCacheStorage,
  type PmtilesCacheStorageHandle,
} from '../map/pmtilesCacheStorage.ts'

const SYNTHETIC_SOURCE_KEY = 'diagnostics://pmtiles-cache'
const SYNTHETIC_ETAG = 'diagnostics-v1'

const syntheticByte = (offset: number): number => (offset * 7 + 13) % 256

const assertPattern = (response: RangeResponse, offset: number, length: number): void => {
  const data = new Uint8Array(response.data)
  if (data.byteLength !== length) throw new Error('PMTiles cache returned a partial range.')
  for (let index = 0; index < length; index += 1) {
    if (data[index] !== syntheticByte(offset + index))
      throw new Error('PMTiles cache returned corrupt bytes.')
  }
}

const createSyntheticRemote = (calls: { offset: number; length: number }[]): Source => ({
  getKey: () => SYNTHETIC_SOURCE_KEY,
  getBytes: (offset, length, signal) => {
    signal?.throwIfAborted()
    calls.push({ offset, length })
    const data = new Uint8Array(length)
    for (let index = 0; index < length; index += 1) data[index] = syntheticByte(offset + index)
    return Promise.resolve({ data: data.buffer, etag: SYNTHETIC_ETAG })
  },
})

const createOfflineRemote = (): Source => ({
  getKey: () => SYNTHETIC_SOURCE_KEY,
  getBytes: () => Promise.reject(new Error('Synthetic offline source.')),
})

const assertFetchedRanges = (calls: readonly { offset: number; length: number }[]): void => {
  const ranges = calls.map(({ offset, length }) => `${offset}/${length}`).join(',')
  if (ranges !== '100/40,160/40,140/20')
    throw new Error('PMTiles cache fetched unexpected byte ranges.')
}

const assertStats = (
  stats: { bytes: number; packs: number; windows: number },
  expected: { bytes: number; packs: number; windows: number },
): void => {
  if (
    stats.bytes !== expected.bytes ||
    stats.packs !== expected.packs ||
    stats.windows !== expected.windows
  )
    throw new Error('PMTiles cache statistics do not match the expected sparse layout.')
}

const runSyntheticCache = async (
  cache: PmtilesCachedSource,
  calls: { offset: number; length: number }[],
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted()
  assertPattern(await cache.getBytes(100, 40, signal), 100, 40)
  await cache.flush()
  assertPattern(await cache.getBytes(160, 40, signal), 160, 40)
  await cache.flush()
  assertPattern(await cache.getBytes(100, 100, signal), 100, 100)
  signal?.throwIfAborted()
  assertFetchedRanges(calls)
  await cache.compact()
  assertStats(await cache.stats(), { bytes: 100, packs: 1, windows: 1 })
}

const runOfflineCache = async (
  storage: PmtilesCacheStorageHandle,
  namespace: string,
  signal?: AbortSignal,
): Promise<void> => {
  const offline = createPmtilesCachedSource({
    storage: storage.storage,
    namespace,
    sourceKey: SYNTHETIC_SOURCE_KEY,
    remote: createOfflineRemote(),
    maxBytes: 4096,
    packTargetBytes: 128,
    idleFlushMs: 0,
  })
  try {
    assertPattern(await offline.getBytes(100, 100, signal), 100, 100)
    signal?.throwIfAborted()
    await offline.clear()
    assertStats(await offline.stats(), { bytes: 0, packs: 0, windows: 0 })
  } finally {
    await offline.clear().catch(() => undefined)
  }
}

const runPmtilesCacheDiagnostic: TaskyonTestFn = async (context) => {
  const signal = context?.abortSignal
  if (!globalThis.crypto?.subtle) return { skipped: true, reason: 'browser-crypto-unavailable' }
  const storage = await createPmtilesCacheStorage()
  if (!storage) return { skipped: true, reason: 'cache-storage-unavailable' }
  const namespace = `pmtiles/diagnostics/${crypto.randomUUID()}`
  const calls: { offset: number; length: number }[] = []
  const cache = createPmtilesCachedSource({
    storage: storage.storage,
    namespace,
    sourceKey: SYNTHETIC_SOURCE_KEY,
    remote: createSyntheticRemote(calls),
    maxBytes: 4096,
    packTargetBytes: 128,
    idleFlushMs: 0,
  })
  try {
    await runSyntheticCache(cache, calls, signal)
    await runOfflineCache(storage, namespace, signal)
    return { bytes: 100, fetchedRanges: 3, packs: 1, windows: 1 }
  } finally {
    await cache.clear().catch(() => undefined)
  }
}

/**
 * Browser diagnostic for the same storage-backed range cache used by the map.
 *
 * It uses a unique synthetic namespace, verifies partial-overlap reuse, real
 * pack persistence, compaction, an offline read through a second cache
 * instance, and clearing. It never touches the world archive or private app
 * state.
 */
export const createPmtilesCacheDiagnostic = (): TaskyonTestFn => {
  runPmtilesCacheDiagnostic.timeoutMs = 30_000
  return runPmtilesCacheDiagnostic
}
