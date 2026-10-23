import { EtagMismatch, type RangeResponse, type Source } from 'pmtiles'

import {
  findFrames,
  insertFrames,
  parseCacheFrames,
  subtractRanges,
  type ByteRange,
  type CacheFrame,
} from './intervals.ts'
import {
  PMTILES_CACHE_STORAGE_CHUNK_BYTES,
  base64UrlHashId,
  concatBytes,
  sha256Digest,
  type PmtilesCacheStorage,
} from './storage.ts'

/** Sparse index partition size in original archive byte offsets. */
export const PMTILES_CACHE_WINDOW_BYTES = 64 * 1024 * 1024
export const PMTILES_CACHE_SCHEMA = 1

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_PACK_BYTES = 4 * 1024 * 1024
const MIN_PACK_BYTES = 64 * 1024
const MAX_PACK_BYTES = 16 * 1024 * 1024
const MAX_HOT_WINDOWS = 32
const MAX_CAS_ATTEMPTS = 8
const MAX_RECENCY_WRITES_PER_FLUSH = 64
const DEFAULT_IDLE_FLUSH_MS = 3_000
const MANIFEST_ID = 'manifest'
const PACK_CONTENT_TYPE = 'application/vnd.taskyon.pmtiles-pack'

interface Manifest {
  schema: typeof PMTILES_CACHE_SCHEMA
  sourceKey: string
  fingerprint: string | null
  updatedAt: number
}

interface WindowIndex {
  schema: typeof PMTILES_CACHE_SCHEMA
  window: number
  fingerprint: string | null
  intervals: CacheFrame[]
}

interface PackDescriptor {
  schema: typeof PMTILES_CACHE_SCHEMA
  packId: string
  size: number
  sha256: `sha256:${string}`
  fingerprint: string | null
  windows: number[]
  createdAt: number
  lastAccess: number
}

interface PendingSpan {
  start: number
  end: number
  data: Uint8Array<ArrayBuffer>
  packOffset: number
}

interface PendingSegment {
  generation: number
  spans: PendingSpan[]
  size: number
}

export interface PmtilesCachedSourceStats {
  readonly sourceKey: string
  readonly bytes: number
  readonly packs: number
  readonly windows: number
  readonly fingerprint: string | null
}

export interface PmtilesCachedSource extends Source {
  /** Flush buffered new spans into immutable packs and publish their indexes. */
  flush: () => Promise<void>
  /** Remove all cached records and packs for this source. */
  clear: () => Promise<void>
  /** Merge small packs within touched windows when their combined bytes fit one pack. */
  compact: () => Promise<void>
  /** Flush pending spans and stop accepting new cache writes. */
  close: () => Promise<void>
  stats: () => Promise<PmtilesCachedSourceStats>
}

export interface PmtilesCachedSourceOptions {
  readonly storage: PmtilesCacheStorage
  /** Scoped record/blob namespace owned by this source cache. */
  readonly namespace: string
  /** Stable identity of the remote archive, normally its URL. */
  readonly sourceKey: string
  /** Raw remote byte-range source. */
  readonly remote: Source
  readonly maxBytes?: number
  readonly packTargetBytes?: number
  /** 0 disables idle flushes; tests should use 0 and call flush explicitly. */
  readonly idleFlushMs?: number
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

const isSafeInteger = (value: number): boolean => Number.isSafeInteger(value)

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

const windowId = (window: number): string => `w${window}`
const windowFor = (offset: number): number => Math.floor(offset / PMTILES_CACHE_WINDOW_BYTES)
const packIdFor = (sha256: `sha256:${string}`): string => `p${base64UrlHashId(sha256)}`
const sha256ForPackId = (packId: string): `sha256:${string}` => `sha256:${packId.slice(1)}`
const windowRange = (window: number): ByteRange => ({
  start: window * PMTILES_CACHE_WINDOW_BYTES,
  end: (window + 1) * PMTILES_CACHE_WINDOW_BYTES,
})

const splitAtWindowBoundaries = (range: ByteRange): ByteRange[] => {
  const ranges: ByteRange[] = []
  for (let window = windowFor(range.start); window <= windowFor(range.end - 1); window += 1) {
    const bounds = windowRange(window)
    ranges.push({
      start: Math.max(range.start, bounds.start),
      end: Math.min(range.end, bounds.end),
    })
  }
  return ranges
}

const parseManifest = (value: unknown, sourceKey: string): Manifest | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<Manifest>
  if (
    record.schema !== PMTILES_CACHE_SCHEMA ||
    record.sourceKey !== sourceKey ||
    (record.fingerprint !== null && typeof record.fingerprint !== 'string') ||
    !isSafeInteger(record.updatedAt as number)
  )
    return undefined
  return {
    schema: PMTILES_CACHE_SCHEMA,
    sourceKey,
    fingerprint: record.fingerprint ?? null,
    updatedAt: record.updatedAt as number,
  }
}

const parseWindowIndex = (value: unknown, window: number): WindowIndex | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<WindowIndex>
  if (
    record.schema !== PMTILES_CACHE_SCHEMA ||
    record.window !== window ||
    (record.fingerprint !== null && typeof record.fingerprint !== 'string')
  )
    return undefined
  const intervals = parseCacheFrames(record.intervals)
  if (!intervals) return undefined
  return {
    schema: PMTILES_CACHE_SCHEMA,
    window,
    fingerprint: record.fingerprint ?? null,
    intervals,
  }
}

const parsePackDescriptor = (value: unknown, packId: string): PackDescriptor | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<PackDescriptor>
  if (
    record.schema !== PMTILES_CACHE_SCHEMA ||
    record.packId !== packId ||
    typeof record.sha256 !== 'string' ||
    !record.sha256.startsWith('sha256:') ||
    packIdFor(record.sha256) !== packId ||
    !isSafeInteger(record.size as number) ||
    (record.size as number) <= 0 ||
    (record.fingerprint !== null && typeof record.fingerprint !== 'string') ||
    !Array.isArray(record.windows) ||
    !record.windows.every((entry) => isSafeInteger(entry) && entry >= 0) ||
    !isSafeInteger(record.createdAt as number) ||
    !isSafeInteger(record.lastAccess as number)
  )
    return undefined
  return {
    schema: PMTILES_CACHE_SCHEMA,
    packId,
    size: record.size as number,
    sha256: record.sha256,
    fingerprint: record.fingerprint ?? null,
    windows: [...new Set(record.windows)].sort((left, right) => left - right),
    createdAt: record.createdAt as number,
    lastAccess: record.lastAccess as number,
  }
}

const framesEqual = (left: readonly CacheFrame[], right: readonly CacheFrame[]): boolean =>
  left.length === right.length &&
  left.every(
    (frame, index) =>
      frame.start === right[index]?.start &&
      frame.end === right[index]?.end &&
      frame.packId === right[index]?.packId &&
      frame.packOffset === right[index]?.packOffset,
  )

const sameRecord = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const emptySegment = (generation: number): PendingSegment => ({
  generation,
  spans: [],
  size: 0,
})

const waitForSignal = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return await promise
  throwIfAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

interface InflightFetch {
  controller: AbortController
  promise: Promise<RangeResponse>
  waiters: number
}

export const createPmtilesCachedSource = (
  options: PmtilesCachedSourceOptions,
): PmtilesCachedSource => {
  const now = options.now ?? Date.now
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES))
  const requestedPackBytes = options.packTargetBytes ?? DEFAULT_PACK_BYTES
  const packTargetBytes = Math.max(
    1,
    Math.min(
      Math.min(MAX_PACK_BYTES, Math.max(MIN_PACK_BYTES, requestedPackBytes)),
      maxBytes > 0 ? maxBytes : Number.MAX_SAFE_INTEGER,
    ),
  )
  const idleFlushMs = Math.max(0, options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS)
  const cacheEnabled = maxBytes > 0

  let manifest: Manifest | undefined
  let packs = new Map<string, PackDescriptor>()
  let totalBytes = 0
  let knownWindows = new Set<number>()
  let hotWindows = new Map<number, WindowIndex>()
  let sequence = 0
  let active = emptySegment(0)
  let pending: PendingSegment[] = []
  let flushChain: Promise<void> = Promise.resolve()
  let initializePromise: Promise<void> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let closed = false
  let storageAvailable = true
  const inflight = new Map<string, InflightFetch>()
  const dirtyRecency = new Set<string>()

  const report = (error: unknown): void => {
    options.onError?.(error)
  }

  const cancelIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const touch = (packId: string): void => {
    sequence += 1
    const descriptor = packs.get(packId)
    if (!descriptor) return
    descriptor.lastAccess = sequence
    dirtyRecency.add(packId)
  }

  const setHotWindow = (window: number, index: WindowIndex): void => {
    hotWindows.delete(window)
    hotWindows.set(window, index)
    while (hotWindows.size > MAX_HOT_WINDOWS) {
      const oldest = hotWindows.keys().next().value
      if (oldest === undefined) break
      hotWindows.delete(oldest)
    }
  }

  const fingerprintCompatible = (fingerprint: string | null): boolean =>
    !manifest?.fingerprint || !fingerprint || manifest.fingerprint === fingerprint

  const initialize = async (): Promise<void> => {
    if (!cacheEnabled || closed) return
    initializePromise ??= (async () => {
      try {
        await loadState()
      } catch (error) {
        storageAvailable = false
        report(error)
      }
    })()
    await initializePromise
  }

  const loadState = async (): Promise<void> => {
    const [{ rows }, { blobs }] = await Promise.all([
      options.storage.list({ namespace: options.namespace }),
      options.storage.listBlobs({ namespace: options.namespace }),
    ])
    const blobSizes = new Map(blobs.map((blob) => [blob.id, blob.size]))
    const manifestRow = rows.find((row) => row.id === MANIFEST_ID)
    manifest = manifestRow ? parseManifest(manifestRow.data, options.sourceKey) : undefined
    if (manifestRow && !manifest) {
      await resetStorage(rows, blobs)
      return
    }
    const windowRows = new Map<number, WindowIndex>()
    const packRows = new Map<string, PackDescriptor>()
    const incompatiblePacks = new Set<string>()
    const deleteRecords: string[] = []
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id === MANIFEST_ID) continue
      const windowMatch = /^w(\d+)$/.exec(row.id)
      if (windowMatch) {
        const window = Number(windowMatch[1])
        const parsed = parseWindowIndex(row.data, window)
        if (!parsed || !fingerprintCompatible(parsed.fingerprint)) deleteRecords.push(row.id)
        else windowRows.set(window, parsed)
        continue
      }
      if (row.id.startsWith('p')) {
        const parsed = parsePackDescriptor(row.data, row.id)
        if (!parsed || !fingerprintCompatible(parsed.fingerprint)) {
          incompatiblePacks.add(row.id)
          deleteRecords.push(row.id)
        } else {
          packRows.set(row.id, parsed)
        }
      }
    }

    const referenced = new Map<string, Set<number>>()
    const dirtyWindows = new Map<number, WindowIndex>()
    knownWindows = new Set()
    for (const [window, index] of windowRows) {
      const intervals = index.intervals.filter(
        (frame) => blobSizes.has(frame.packId) && !incompatiblePacks.has(frame.packId),
      )
      if (intervals.length === 0) {
        deleteRecords.push(windowId(window))
        continue
      }
      if (intervals.length !== index.intervals.length) {
        dirtyWindows.set(window, { ...index, intervals })
      }
      knownWindows.add(window)
      for (const frame of intervals) {
        const windows = referenced.get(frame.packId) ?? new Set<number>()
        windows.add(window)
        referenced.set(frame.packId, windows)
      }
    }

    packs = new Map()
    totalBytes = 0
    for (const [packId, size] of blobSizes) {
      if (!packId.startsWith('p')) continue
      const windows = referenced.get(packId)
      if (!windows || windows.size === 0 || incompatiblePacks.has(packId)) {
        await options.storage.deleteBlob({ namespace: options.namespace, id: packId })
        continue
      }
      const existing = packRows.get(packId)
      const sha256 = sha256ForPackId(packId)
      const descriptor: PackDescriptor = existing
        ? { ...existing }
        : {
            schema: PMTILES_CACHE_SCHEMA,
            packId,
            size,
            sha256,
            fingerprint: manifest?.fingerprint ?? null,
            windows: [],
            createdAt: now(),
            lastAccess: 0,
          }
      descriptor.size = size
      descriptor.sha256 = sha256
      descriptor.windows = [...windows].sort((left, right) => left - right)
      packs.set(packId, descriptor)
      totalBytes += size
      sequence = Math.max(sequence, descriptor.lastAccess)
      if (!existing || !sameRecord(existing, descriptor)) {
        await options.storage.set({
          namespace: options.namespace,
          id: packId,
          value: descriptor,
        })
      }
    }

    for (const packId of packRows.keys()) {
      if (!blobSizes.has(packId)) deleteRecords.push(packId)
    }
    const deleteSet = new Set(deleteRecords)
    for (const packId of packs.keys()) deleteSet.delete(packId)
    for (const id of deleteSet) {
      await options.storage.delete({ namespace: options.namespace, id })
    }
    for (const [window, index] of dirtyWindows) {
      if (!knownWindows.has(window)) continue
      await options.storage.set({
        namespace: options.namespace,
        id: windowId(window),
        value: index,
      })
      setHotWindow(window, index)
    }

    await enforceQuota()
  }

  const resetStorage = async (
    rows: readonly { id: string | number; data: unknown }[],
    blobs: readonly { id: string; size: number }[],
  ): Promise<void> => {
    await Promise.all([
      ...rows.map((row) => options.storage.delete({ namespace: options.namespace, id: row.id })),
      ...blobs.map((blob) =>
        options.storage.deleteBlob({ namespace: options.namespace, id: blob.id }),
      ),
    ])
    manifest = undefined
    packs = new Map()
    totalBytes = 0
    knownWindows = new Set()
    hotWindows = new Map()
  }

  const readWindow = async (window: number): Promise<WindowIndex> => {
    const hot = hotWindows.get(window)
    if (hot) {
      hotWindows.delete(window)
      hotWindows.set(window, hot)
      return hot
    }
    const stored = await options.storage.get({
      namespace: options.namespace,
      id: windowId(window),
    })
    const parsed = parseWindowIndex(stored.value, window)
    if (!parsed || !fingerprintCompatible(parsed.fingerprint)) {
      if (stored.value !== null) {
        await options.storage.delete({ namespace: options.namespace, id: windowId(window) })
      }
      knownWindows.delete(window)
      return {
        schema: PMTILES_CACHE_SCHEMA,
        window,
        fingerprint: manifest?.fingerprint ?? null,
        intervals: [],
      }
    }
    knownWindows.add(window)
    setHotWindow(window, parsed)
    return parsed
  }

  const updateWindow = async (
    window: number,
    transform: (intervals: readonly CacheFrame[]) => CacheFrame[],
  ): Promise<{ intervals: CacheFrame[]; changed: boolean }> => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await options.storage.get({
        namespace: options.namespace,
        id: windowId(window),
      })
      const current = parseWindowIndex(stored.value, window)
      const base = current && fingerprintCompatible(current.fingerprint) ? current.intervals : []
      const next = transform(base)
      if (framesEqual(base, next)) return { intervals: next, changed: false }
      if (next.length === 0) {
        if (stored.value !== null) {
          await options.storage.delete({
            namespace: options.namespace,
            id: windowId(window),
          })
        }
        hotWindows.delete(window)
        knownWindows.delete(window)
        return { intervals: next, changed: true }
      }
      const record: WindowIndex = {
        schema: PMTILES_CACHE_SCHEMA,
        window,
        fingerprint: manifest?.fingerprint ?? null,
        intervals: next,
      }
      const result = await options.storage.setIfUnchanged({
        namespace: options.namespace,
        id: windowId(window),
        expectedContentHash: stored.contentHash,
        value: record,
      })
      if (result.written) {
        setHotWindow(window, record)
        knownWindows.add(window)
        return { intervals: next, changed: true }
      }
    }
    throw new Error('PMTiles window index changed repeatedly during publication.')
  }

  const updateWindowIntervals = async (
    window: number,
    additions: readonly CacheFrame[],
  ): Promise<boolean> => {
    let added = false
    await updateWindow(window, (intervals) => {
      const next = insertFrames(intervals, additions)
      added = next.length > intervals.length
      return next
    })
    return added
  }

  const writePackBlob = async (
    packId: string,
    sha256: `sha256:${string}`,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<boolean> => {
    const stat = await options.storage.statBlob({
      namespace: options.namespace,
      id: packId,
    })
    if (stat?.size === bytes.byteLength) return false
    const { writeId } = await options.storage.beginBlobWrite({
      namespace: options.namespace,
      id: packId,
      contentType: PACK_CONTENT_TYPE,
    })
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += PMTILES_CACHE_STORAGE_CHUNK_BYTES) {
        const end = Math.min(bytes.byteLength, offset + PMTILES_CACHE_STORAGE_CHUNK_BYTES)
        await options.storage.writeBlobChunk({
          namespace: options.namespace,
          id: packId,
          writeId,
          offset,
          data: bytes.subarray(offset, end),
        })
      }
      await options.storage.commitBlobWrite({
        namespace: options.namespace,
        id: packId,
        writeId,
        expectedSize: bytes.byteLength,
        expectedSha256: sha256,
      })
    } catch (error) {
      await options.storage
        .abortBlobWrite({ namespace: options.namespace, id: packId, writeId })
        .catch(() => undefined)
      throw error
    }
    return true
  }

  const mergePackDescriptor = async (
    packId: string,
    sha256: `sha256:${string}`,
    size: number,
    windows: readonly number[],
  ): Promise<void> => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const stored = await options.storage.get({
        namespace: options.namespace,
        id: packId,
      })
      const current = parsePackDescriptor(stored.value, packId)
      const merged = [...new Set([...(current?.windows ?? []), ...windows])].sort(
        (left, right) => left - right,
      )
      const descriptor: PackDescriptor = {
        schema: PMTILES_CACHE_SCHEMA,
        packId,
        size,
        sha256,
        fingerprint: manifest?.fingerprint ?? null,
        windows: merged,
        createdAt: current?.createdAt ?? now(),
        lastAccess: Math.max(current?.lastAccess ?? 0, packs.get(packId)?.lastAccess ?? 0),
      }
      if (sameRecord(stored.value, descriptor)) {
        packs.set(packId, descriptor)
        return
      }
      const result = await options.storage.setIfUnchanged({
        namespace: options.namespace,
        id: packId,
        expectedContentHash: stored.contentHash,
        value: descriptor,
      })
      if (result.written) {
        if (!packs.has(packId)) totalBytes += size
        packs.set(packId, descriptor)
        return
      }
    }
    throw new Error('PMTiles pack descriptor changed repeatedly during publication.')
  }

  const flushSegment = async (segment: PendingSegment): Promise<void> => {
    if (segment.generation !== generation || segment.spans.length === 0) return
    const bytes = concatBytes(segment.spans.map((span) => span.data))
    const sha256 = await sha256Digest(bytes)
    const packId = packIdFor(sha256)
    let cursor = 0
    for (const span of segment.spans) {
      span.packOffset = cursor
      cursor += span.data.byteLength
    }
    const knownPack = packs.has(packId)
    await writePackBlob(packId, sha256, bytes)
    const windows = [...new Set(segment.spans.map((span) => windowFor(span.start)))].sort(
      (left, right) => left - right,
    )
    await mergePackDescriptor(packId, sha256, bytes.byteLength, windows)
    let referenced = knownPack
    for (const window of windows) {
      if (segment.generation !== generation) return
      const additions = segment.spans
        .filter((span) => windowFor(span.start) === window)
        .map(
          (span): CacheFrame => ({
            start: span.start,
            end: span.end,
            packId,
            packOffset: span.packOffset,
          }),
        )
      if (await updateWindowIntervals(window, additions)) referenced = true
    }
    if (!referenced) {
      await options.storage
        .deleteBlob({ namespace: options.namespace, id: packId })
        .catch(() => undefined)
      await options.storage
        .delete({ namespace: options.namespace, id: packId })
        .catch(() => undefined)
      packs.delete(packId)
      totalBytes = Math.max(0, totalBytes - bytes.byteLength)
    } else {
      touch(packId)
    }
    await enforceQuota()
  }

  const persistRecency = async (): Promise<void> => {
    let writes = 0
    for (const packId of [...dirtyRecency]) {
      if (writes >= MAX_RECENCY_WRITES_PER_FLUSH) break
      const descriptor = packs.get(packId)
      if (!descriptor) {
        dirtyRecency.delete(packId)
        continue
      }
      const stored = await options.storage.get({
        namespace: options.namespace,
        id: packId,
      })
      const current = parsePackDescriptor(stored.value, packId)
      if (!current) {
        dirtyRecency.delete(packId)
        continue
      }
      if (current.lastAccess >= descriptor.lastAccess) {
        dirtyRecency.delete(packId)
        continue
      }
      const result = await options.storage.setIfUnchanged({
        namespace: options.namespace,
        id: packId,
        expectedContentHash: stored.contentHash,
        value: { ...current, lastAccess: descriptor.lastAccess },
      })
      if (result.written) {
        dirtyRecency.delete(packId)
        writes += 1
      }
    }
  }

  const flush = async (): Promise<void> => {
    const run = async (): Promise<void> => {
      if (active.spans.length > 0) {
        pending.push(active)
        active = emptySegment(generation)
      }
      while (pending.length > 0) {
        const segment = pending[0]!
        try {
          await flushSegment(segment)
        } catch (error) {
          report(error)
        } finally {
          pending.shift()
        }
      }
      await persistRecency().catch(report)
    }
    flushChain = flushChain.then(run, run)
    await flushChain
  }

  const scheduleFlush = (immediate: boolean): void => {
    if (!cacheEnabled || closed || idleFlushMs === 0) return
    cancelIdle()
    if (immediate) {
      void flush().catch(report)
      return
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      void flush().catch(report)
    }, idleFlushMs)
    const unref = (idleTimer as { unref?: () => void }).unref
    if (unref) unref.call(idleTimer)
  }

  const removePack = async (packId: string): Promise<void> => {
    const descriptor = packs.get(packId)
    for (const window of descriptor?.windows ?? []) {
      await updateWindow(window, (intervals) =>
        intervals.filter((frame) => frame.packId !== packId),
      )
      hotWindows.delete(window)
    }
    await options.storage.delete({ namespace: options.namespace, id: packId })
    await options.storage.deleteBlob({ namespace: options.namespace, id: packId })
    if (descriptor) totalBytes = Math.max(0, totalBytes - descriptor.size)
    packs.delete(packId)
    dirtyRecency.delete(packId)
  }

  const invalidatePack = async (packId: string): Promise<void> => {
    try {
      await removePack(packId)
    } catch (error) {
      report(error)
    }
  }

  async function enforceQuota(): Promise<void> {
    while (totalBytes > maxBytes && packs.size > 0) {
      const oldest = [...packs.values()].sort(
        (left, right) => left.lastAccess - right.lastAccess || left.createdAt - right.createdAt,
      )[0]
      if (!oldest) break
      try {
        await removePack(oldest.packId)
      } catch (error) {
        report(error)
        break
      }
    }
  }

  const appendFetchedRange = (start: number, data: Uint8Array<ArrayBuffer>): void => {
    let cursor = 0
    while (cursor < data.byteLength) {
      const take = Math.min(packTargetBytes - active.size, data.byteLength - cursor)
      if (take <= 0) break
      active.spans.push({
        start: start + cursor,
        end: start + cursor + take,
        data: data.subarray(cursor, cursor + take),
        packOffset: 0,
      })
      active.size += take
      cursor += take
      if (active.size >= packTargetBytes) {
        pending.push(active)
        active = emptySegment(generation)
        scheduleFlush(true)
      }
    }
  }

  const pendingSpansFor = (window: number): PendingSpan[] => {
    const range = windowRange(window)
    const spans: PendingSpan[] = []
    for (const segment of [active, ...pending]) {
      for (const span of segment.spans) {
        if (span.end > range.start && span.start < range.end) spans.push(span)
      }
    }
    return spans
  }

  const readPackRange = async (
    packId: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let cursor = 0
    while (cursor < length) {
      const readLength = Math.min(PMTILES_CACHE_STORAGE_CHUNK_BYTES, length - cursor)
      const response = await options.storage.readBlobRange({
        namespace: options.namespace,
        id: packId,
        offset: offset + cursor,
        length: readLength,
      })
      if (response.data.byteLength === 0) throw new Error('PMTiles pack is truncated.')
      chunks.push(response.data)
      cursor += response.data.byteLength
      if (response.eof && cursor < length) throw new Error('PMTiles pack is truncated.')
    }
    return concatBytes(chunks)
  }

  const collectLocal = async (
    start: number,
    length: number,
    output: Uint8Array<ArrayBuffer>,
  ): Promise<ByteRange[]> => {
    const covered: ByteRange[] = []
    const end = start + length
    for (let window = windowFor(start); window <= windowFor(end - 1); window += 1) {
      const range = windowRange(window)
      const request: ByteRange = {
        start: Math.max(start, range.start),
        end: Math.min(end, range.end),
      }
      const index = await readWindow(window)
      for (const frame of findFrames(index.intervals, request)) {
        const from = Math.max(frame.start, request.start)
        const to = Math.min(frame.end, request.end)
        try {
          const data = await readPackRange(
            frame.packId,
            frame.packOffset + (from - frame.start),
            to - from,
          )
          output.set(data, from - start)
          covered.push({ start: from, end: to })
          touch(frame.packId)
        } catch (error) {
          report(error)
          void invalidatePack(frame.packId)
        }
      }
      for (const span of pendingSpansFor(window)) {
        const from = Math.max(span.start, request.start)
        const to = Math.min(span.end, request.end)
        if (to <= from) continue
        for (const gap of subtractRanges(covered, { start: from, end: to })) {
          output.set(
            span.data.subarray(gap.start - span.start, gap.end - span.start),
            gap.start - start,
          )
          covered.push(gap)
        }
      }
    }
    return covered
  }

  const fetchGap = async (
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> => {
    const key = `${offset}:${length}:${etag ?? ''}`
    let entry = inflight.get(key)
    if (!entry) {
      const controller = new AbortController()
      const promise = options.remote.getBytes(offset, length, controller.signal, etag)
      promise.catch(() => undefined)
      entry = { controller, promise, waiters: 0 }
      inflight.set(key, entry)
    }
    entry.waiters += 1
    try {
      return await waitForSignal(entry.promise, signal)
    } finally {
      entry.waiters -= 1
      if (entry.waiters === 0) {
        entry.controller.abort()
        inflight.delete(key)
      }
    }
  }

  const reconcileResponseEtag = async (responseEtag?: string): Promise<string | undefined> => {
    const storedEtag = responseEtag ?? manifest?.fingerprint ?? undefined
    if (!responseEtag) return storedEtag
    if (manifest?.fingerprint && manifest.fingerprint !== responseEtag) {
      await clear()
      throw new EtagMismatch('Remote PMTiles archive changed; cached ranges were discarded.')
    }
    if (!manifest?.fingerprint) {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const stored = await options.storage.get({
          namespace: options.namespace,
          id: MANIFEST_ID,
        })
        const current = parseManifest(stored.value, options.sourceKey)
        if (current?.fingerprint && current.fingerprint !== responseEtag) {
          await clear()
          throw new EtagMismatch('Remote PMTiles archive changed; cached ranges were discarded.')
        }
        if (current?.fingerprint) {
          manifest = current
          return responseEtag
        }
        const next: Manifest = {
          schema: PMTILES_CACHE_SCHEMA,
          sourceKey: options.sourceKey,
          fingerprint: responseEtag,
          updatedAt: now(),
        }
        const result = await options.storage.setIfUnchanged({
          namespace: options.namespace,
          id: MANIFEST_ID,
          expectedContentHash: stored.contentHash,
          value: next,
        })
        if (result.written) {
          manifest = next
          return responseEtag
        }
      }
      throw new Error('PMTiles source manifest changed repeatedly during verification.')
    }
    return storedEtag
  }

  const detachPackWindow = async (packId: string, window: number): Promise<void> => {
    const descriptor = packs.get(packId)
    if (!descriptor) return
    const windows = descriptor.windows.filter((entry) => entry !== window)
    if (windows.length === 0) {
      await removePack(packId)
      return
    }
    const stored = await options.storage.get({
      namespace: options.namespace,
      id: packId,
    })
    const current = parsePackDescriptor(stored.value, packId)
    if (!current) return
    const result = await options.storage.setIfUnchanged({
      namespace: options.namespace,
      id: packId,
      expectedContentHash: stored.contentHash,
      value: { ...current, windows },
    })
    if (result.written) descriptor.windows = windows
  }

  const compactWindow = async (window: number): Promise<boolean> => {
    const index = await readWindow(window)
    const packIds = [...new Set(index.intervals.map((frame) => frame.packId))]
    const small = packIds.filter((packId) => {
      const descriptor = packs.get(packId)
      return descriptor !== undefined && descriptor.size < packTargetBytes / 2
    })
    if (small.length < 2) return false
    const frames = index.intervals.filter((frame) => small.includes(frame.packId))
    const total = frames.reduce((sum, frame) => sum + (frame.end - frame.start), 0)
    if (total <= 0 || total > packTargetBytes) return false
    const chunks: Uint8Array<ArrayBuffer>[] = []
    const replacements: CacheFrame[] = []
    let cursor = 0
    for (const frame of frames) {
      const data = await readPackRange(frame.packId, frame.packOffset, frame.end - frame.start)
      chunks.push(data)
      replacements.push({
        start: frame.start,
        end: frame.end,
        packId: '',
        packOffset: cursor,
      })
      cursor += data.byteLength
    }
    const data = concatBytes(chunks)
    const sha256 = await sha256Digest(data)
    const packId = packIdFor(sha256)
    const knownPack = packs.has(packId)
    await writePackBlob(packId, sha256, data)
    await mergePackDescriptor(packId, sha256, data.byteLength, [window])
    const nextFrames = replacements
      .map((frame) => ({ ...frame, packId }))
      .sort((left, right) => left.start - right.start)
    const updated = await updateWindow(window, (intervals) =>
      intervals
        .filter((frame) => !small.includes(frame.packId))
        .concat(nextFrames)
        .sort((left, right) => left.start - right.start),
    )
    if (!updated.changed) {
      if (!knownPack) {
        await options.storage
          .deleteBlob({ namespace: options.namespace, id: packId })
          .catch(() => undefined)
        await options.storage
          .delete({ namespace: options.namespace, id: packId })
          .catch(() => undefined)
        packs.delete(packId)
        totalBytes = Math.max(0, totalBytes - data.byteLength)
      }
      return false
    }
    for (const oldPackId of small) await detachPackWindow(oldPackId, window)
    touch(packId)
    await enforceQuota()
    return true
  }

  const compact = async (): Promise<void> => {
    await flush()
    for (const window of [...knownWindows]) {
      try {
        await compactWindow(window)
      } catch (error) {
        report(error)
      }
    }
    await persistRecency().catch(report)
  }

  const clear = async (): Promise<void> => {
    generation += 1
    cancelIdle()
    active = emptySegment(generation)
    pending = []
    await flushChain.catch(() => undefined)
    if (!storageAvailable) {
      packs = new Map()
      totalBytes = 0
      knownWindows = new Set()
      hotWindows = new Map()
      manifest = undefined
      initializePromise = undefined
      return
    }
    try {
      const [{ rows }, { blobs }] = await Promise.all([
        options.storage.list({ namespace: options.namespace }),
        options.storage.listBlobs({ namespace: options.namespace }),
      ])
      await resetStorage(rows, blobs)
      initializePromise = undefined
    } catch (error) {
      report(error)
    }
  }

  const stats = async (): Promise<PmtilesCachedSourceStats> => {
    await initialize()
    const pendingBytes = [active, ...pending].reduce((total, segment) => total + segment.size, 0)
    return {
      sourceKey: options.sourceKey,
      bytes: totalBytes + pendingBytes,
      packs: packs.size,
      windows: knownWindows.size,
      fingerprint: manifest?.fingerprint ?? null,
    }
  }

  const getBytes = async (
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> => {
    if (!isSafeInteger(offset) || offset < 0 || !isSafeInteger(length) || length < 0)
      throw new RangeError('PMTiles ranges require a non-negative offset and length.')
    throwIfAborted(signal)
    if (length === 0)
      return {
        data: new ArrayBuffer(0),
        ...((manifest?.fingerprint ?? etag) ? { etag: manifest?.fingerprint ?? etag } : {}),
      }
    if (!cacheEnabled || closed) return await options.remote.getBytes(offset, length, signal, etag)
    await initialize()
    if (!storageAvailable) return await options.remote.getBytes(offset, length, signal, etag)
    if (etag && manifest?.fingerprint && etag !== manifest.fingerprint) {
      await clear()
      throw new EtagMismatch('Cached PMTiles source identity does not match the requested ETag.')
    }

    const requestGeneration = generation
    const output = new Uint8Array(length)
    let covered: ByteRange[]
    try {
      covered = await collectLocal(offset, length, output)
    } catch (error) {
      if (error instanceof EtagMismatch) throw error
      report(error)
      return await options.remote.getBytes(offset, length, signal, etag)
    }

    let responseEtag: string | undefined = manifest?.fingerprint ?? etag
    let cacheControl: string | undefined
    let expires: string | undefined
    const missing = subtractRanges(covered, { start: offset, end: offset + length }).flatMap(
      splitAtWindowBoundaries,
    )
    for (const gap of missing) {
      throwIfAborted(signal)
      const response = await fetchGap(gap.start, gap.end - gap.start, signal, etag)
      const data = new Uint8Array(response.data)
      if (data.byteLength !== gap.end - gap.start)
        throw new Error('Remote PMTiles source returned an unexpected byte count.')
      output.set(data, gap.start - offset)
      responseEtag = await reconcileResponseEtag(response.etag)
      cacheControl = response.cacheControl ?? cacheControl
      expires = response.expires ?? expires
      try {
        if (requestGeneration === generation) appendFetchedRange(gap.start, data)
      } catch (error) {
        report(error)
      }
    }
    scheduleFlush(false)
    return {
      data: output.buffer,
      ...(responseEtag ? { etag: responseEtag } : {}),
      ...(cacheControl ? { cacheControl } : {}),
      ...(expires ? { expires } : {}),
    }
  }

  return {
    getKey: () => options.sourceKey,
    getBytes,
    flush,
    clear,
    compact,
    async close() {
      if (closed) return
      closed = true
      cancelIdle()
      await flush()
    },
    stats,
  }
}
