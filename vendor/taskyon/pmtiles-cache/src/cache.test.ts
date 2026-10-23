/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- node:test and deterministic source doubles intentionally use unawaited promises */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EtagMismatch, PMTiles, type RangeResponse, type Source } from 'pmtiles'

import {
  PMTILES_CACHE_WINDOW_BYTES,
  createPmtilesCachedSource,
  type PmtilesCachedSource,
} from './cache.ts'
import { sha256Digest } from './storage.ts'
import { createTestArchive, createTestTiles } from './testSupport/archiveFixture.ts'
import { createMemoryPmtilesStorage } from './testSupport/memoryStorage.ts'

const NAMESPACE = 'pmtiles/test-world'
const SOURCE_KEY = 'https://example.invalid/world.pmtiles'

const patternByte = (offset: number): number => offset % 251

const expectPattern = (response: RangeResponse, offset: number, length: number): void => {
  const data = new Uint8Array(response.data)
  assert.equal(data.byteLength, length)
  for (let index = 0; index < length; index += 1) {
    assert.equal(data[index], patternByte(offset + index))
  }
}

const createPatternRemote = () => {
  const calls: { offset: number; length: number }[] = []
  let etag: string | undefined = 'v1'
  const remote: Source = {
    getKey: () => SOURCE_KEY,
    getBytes: async (offset, length, signal) => {
      signal?.throwIfAborted()
      calls.push({ offset, length })
      const data = new Uint8Array(length)
      for (let index = 0; index < length; index += 1) data[index] = patternByte(offset + index)
      return { data: data.buffer, ...(etag ? { etag } : {}) }
    },
  }
  return {
    calls,
    remote,
    setEtag: (next: string | undefined) => {
      etag = next
    },
  }
}

const createBytesRemote = (bytes: Uint8Array) => {
  const calls: { offset: number; length: number }[] = []
  let etag: string | undefined = 'archive-v1'
  const remote: Source = {
    getKey: () => SOURCE_KEY,
    getBytes: async (offset, length, signal) => {
      signal?.throwIfAborted()
      calls.push({ offset, length })
      const slice = bytes.slice(offset, offset + length)
      return {
        data: slice.buffer,
        ...(etag ? { etag } : {}),
      }
    },
  }
  return {
    calls,
    remote,
    setEtag: (next: string | undefined) => {
      etag = next
    },
  }
}

const createSource = (
  storage: ReturnType<typeof createMemoryPmtilesStorage>,
  remote: Source,
  overrides: Partial<Parameters<typeof createPmtilesCachedSource>[0]> = {},
): PmtilesCachedSource =>
  createPmtilesCachedSource({
    storage,
    namespace: NAMESPACE,
    sourceKey: SOURCE_KEY,
    remote,
    maxBytes: 8 * 1024 * 1024,
    packTargetBytes: 1024 * 1024,
    idleFlushMs: 0,
    now: () => 1_000,
    ...overrides,
  })

test('reuses partial overlaps and fetches only the uncovered gap', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote, calls } = createPatternRemote()
  const source = createSource(storage, remote)

  expectPattern(await source.getBytes(100, 40), 100, 40)
  await source.flush()
  expectPattern(await source.getBytes(160, 40), 160, 40)
  await source.flush()
  assert.deepEqual(calls, [
    { offset: 100, length: 40 },
    { offset: 160, length: 40 },
  ])

  expectPattern(await source.getBytes(100, 100), 100, 100)
  assert.deepEqual(calls, [
    { offset: 100, length: 40 },
    { offset: 160, length: 40 },
    { offset: 140, length: 20 },
  ])
  await source.flush()
  expectPattern(await source.getBytes(100, 100), 100, 100)
  assert.equal(calls.length, 3)
})

test('keeps the first 16 KiB as a small pack without reserving a 64 MiB window', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  expectPattern(await source.getBytes(0, 16 * 1024), 0, 16 * 1024)
  await source.flush()
  const blobSizes = [...storage.listRecords(NAMESPACE)]
    .filter((row) => row.id.startsWith('p'))
    .map((row) => row.data as { size: number })
  assert.equal(blobSizes.length, 1)
  assert.equal(blobSizes[0]?.size, 16 * 1024)
  const stats = await source.stats()
  assert.equal(stats.bytes, 16 * 1024)
  assert.equal(stats.windows, 1)
})

test('handles requests crossing a 64 MiB window boundary', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote, calls } = createPatternRemote()
  const source = createSource(storage, remote)
  const start = PMTILES_CACHE_WINDOW_BYTES - 10
  expectPattern(await source.getBytes(start, 20), start, 20)
  await source.flush()
  assert.deepEqual(calls, [
    { offset: start, length: 10 },
    { offset: start + 10, length: 10 },
  ])
  expectPattern(await source.getBytes(start, 20), start, 20)
  assert.equal(calls.length, 2)
  assert.equal((await source.stats()).windows, 2)
})

test('boots the standard PMTiles reader from cached bytes with no network', async () => {
  const storage = createMemoryPmtilesStorage()
  const archive = createTestArchive(createTestTiles())
  const online = createBytesRemote(archive)
  const first = createSource(storage, online.remote)
  const firstReader = new PMTiles(first)
  const header = await firstReader.getHeader()
  const metadata = await firstReader.getMetadata()
  const tile = await firstReader.getZxy(1, 0, 0)
  assert.ok(tile)
  assert.deepEqual(metadata, { name: 'test-world' })
  await first.flush()
  await first.close()

  const offline: Source = {
    getKey: () => SOURCE_KEY,
    getBytes: async () => {
      throw new Error('network disabled')
    },
  }
  const second = createSource(storage, offline)
  const secondReader = new PMTiles(second)
  assert.deepEqual(await secondReader.getHeader(), header)
  assert.deepEqual(await secondReader.getMetadata(), metadata)
  const cachedTile = await secondReader.getZxy(1, 0, 0)
  assert.deepEqual(new Uint8Array(cachedTile!.data), new Uint8Array(tile.data))
})

test('evicts the least recently used pack and refetches evicted bytes', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote, calls } = createPatternRemote()
  const source = createSource(storage, remote, { maxBytes: 30, packTargetBytes: 16 })
  expectPattern(await source.getBytes(0, 20), 0, 20)
  await source.flush()
  expectPattern(await source.getBytes(100, 20), 100, 20)
  await source.flush()
  assert.ok((await source.stats()).bytes <= 30)
  const before = calls.length
  expectPattern(await source.getBytes(0, 20), 0, 20)
  assert.equal(calls.length, before + 1)
  assert.deepEqual(calls[calls.length - 1], { offset: 0, length: 20 })
})

test('compacts small packs within a window without changing covered bytes', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote, { maxBytes: 100, packTargetBytes: 16 })
  expectPattern(await source.getBytes(0, 40), 0, 40)
  await source.flush()
  expectPattern(await source.getBytes(100, 40), 100, 40)
  await source.flush()
  assert.equal((await source.stats()).packs, 2)
  await source.compact()
  assert.equal((await source.stats()).packs, 1)
  assert.equal((await source.stats()).bytes, 80)
  expectPattern(await source.getBytes(0, 40), 0, 40)
  expectPattern(await source.getBytes(100, 40), 100, 40)
})

test('discards ranges and reports a changed source fingerprint', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote, setEtag } = createPatternRemote()
  const source = createSource(storage, remote)
  expectPattern(await source.getBytes(0, 10), 0, 10)
  await source.flush()
  setEtag('v2')
  await assert.rejects(() => source.getBytes(100, 10), EtagMismatch)
  assert.deepEqual(await source.stats(), {
    sourceKey: SOURCE_KEY,
    bytes: 0,
    packs: 0,
    windows: 0,
    fingerprint: null,
  })
  expectPattern(await source.getBytes(0, 10), 0, 10)
  assert.equal((await source.stats()).fingerprint, 'v2')
})

test('a requested ETag mismatch invalidates cached ranges before retrying', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote, setEtag } = createPatternRemote()
  const source = createSource(storage, remote)
  expectPattern(await source.getBytes(0, 10), 0, 10)
  await source.flush()
  setEtag('v2')
  await assert.rejects(() => source.getBytes(0, 10, undefined, 'v2'), EtagMismatch)
  assert.equal((await source.stats()).bytes, 0)
  expectPattern(await source.getBytes(0, 10), 0, 10)
  assert.equal((await source.stats()).fingerprint, 'v2')
})

test('aborting one waiter does not corrupt or keep the shared fetch alive', async () => {
  const storage = createMemoryPmtilesStorage()
  let slow = true
  let startedResolve: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve
  })
  const remote: Source = {
    getKey: () => SOURCE_KEY,
    getBytes: async (offset, length, signal) => {
      if (offset === 50 && slow) {
        slow = false
        startedResolve?.()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      }
      const data = new Uint8Array(length)
      for (let index = 0; index < length; index += 1) data[index] = patternByte(offset + index)
      return { data: data.buffer }
    },
  }
  const source = createSource(storage, remote)
  const controller = new AbortController()
  const pending = source.getBytes(50, 10, controller.signal)
  await started
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException)
  expectPattern(await source.getBytes(50, 10), 50, 10)
})

test('retries a conditional window update after a CAS collision', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  storage.setIfUnchangedFailures = 1
  expectPattern(await source.getBytes(10, 10), 10, 10)
  await source.flush()
  const windows = storage.listRecords(NAMESPACE).filter((row) => row.id.startsWith('w'))
  assert.equal(windows.length, 1)
})

test('reconstructs a descriptor when a pack was committed before its index', async () => {
  const storage = createMemoryPmtilesStorage()
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index)
  const sha256 = await sha256Digest(bytes)
  const packId = `p${sha256.slice('sha256:'.length)}`
  storage.blobs.set(`${NAMESPACE}/${packId}`, bytes)
  await storage.set({
    namespace: NAMESPACE,
    id: 'w0',
    value: {
      schema: 1,
      window: 0,
      fingerprint: 'archive-v1',
      intervals: [{ start: 0, end: 16, packId, packOffset: 0 }],
    },
  })
  await storage.set({
    namespace: NAMESPACE,
    id: 'manifest',
    value: {
      schema: 1,
      sourceKey: SOURCE_KEY,
      fingerprint: 'archive-v1',
      updatedAt: 1,
    },
  })
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  const stats = await source.stats()
  assert.equal(stats.packs, 1)
  assert.equal(stats.bytes, 16)
  expectPattern(await source.getBytes(0, 16), 0, 16)
})

test('drops ranges whose pack descriptor belongs to another source version', async () => {
  const storage = createMemoryPmtilesStorage()
  const bytes = Uint8Array.from({ length: 8 }, () => 9)
  const sha256 = await sha256Digest(bytes)
  const packId = `p${sha256.slice('sha256:'.length)}`
  storage.blobs.set(`${NAMESPACE}/${packId}`, bytes)
  await storage.set({
    namespace: NAMESPACE,
    id: 'manifest',
    value: { schema: 1, sourceKey: SOURCE_KEY, fingerprint: 'v2', updatedAt: 1 },
  })
  await storage.set({
    namespace: NAMESPACE,
    id: packId,
    value: {
      schema: 1,
      packId,
      size: 8,
      sha256,
      fingerprint: 'v1',
      windows: [0],
      createdAt: 1,
      lastAccess: 1,
    },
  })
  await storage.set({
    namespace: NAMESPACE,
    id: 'w0',
    value: {
      schema: 1,
      window: 0,
      fingerprint: 'v2',
      intervals: [{ start: 0, end: 8, packId, packOffset: 0 }],
    },
  })
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  assert.equal((await source.stats()).packs, 0)
  assert.equal((await source.stats()).bytes, 0)
  assert.equal(storage.blobs.size, 0)
})

test('removes orphan blobs and descriptors from an interrupted publication', async () => {
  const storage = createMemoryPmtilesStorage()
  const bytes = Uint8Array.from({ length: 8 }, () => 7)
  const sha256 = await sha256Digest(bytes)
  const packId = `p${sha256.slice('sha256:'.length)}`
  storage.blobs.set(`${NAMESPACE}/${packId}`, bytes)
  await storage.set({
    namespace: NAMESPACE,
    id: 'manifest',
    value: {
      schema: 1,
      sourceKey: SOURCE_KEY,
      fingerprint: 'archive-v1',
      updatedAt: 1,
    },
  })
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  const stats = await source.stats()
  assert.equal(stats.packs, 0)
  assert.equal(storage.blobs.size, 0)
})

test('falls back to the remote when a referenced pack is missing', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote, calls } = createPatternRemote()
  const source = createSource(storage, remote)
  expectPattern(await source.getBytes(10, 10), 10, 10)
  await source.flush()
  const packKey = [...storage.blobs.keys()][0]
  assert.ok(packKey)
  storage.blobs.delete(packKey)
  expectPattern(await source.getBytes(10, 10), 10, 10)
  assert.equal(calls.length, 2)
})

test('simulated multi-gigabyte offsets stay sparse and bounded', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  const offsets = [
    2 * 1024 * 1024 * 1024 + 10,
    4 * 1024 * 1024 * 1024 + 10,
    8 * 1024 * 1024 * 1024 - 10,
  ]
  for (const offset of offsets) {
    expectPattern(await source.getBytes(offset, 8), offset, 8)
  }
  await source.flush()
  const stats = await source.stats()
  assert.equal(stats.bytes, 24)
  assert.equal(stats.windows, 3)
  assert.equal(storage.blobs.size, 1)
})

test('clear removes records, packs and the manifest', async () => {
  const storage = createMemoryPmtilesStorage()
  const { remote } = createPatternRemote()
  const source = createSource(storage, remote)
  expectPattern(await source.getBytes(0, 10), 0, 10)
  await source.flush()
  await source.clear()
  assert.deepEqual(await source.stats(), {
    sourceKey: SOURCE_KEY,
    bytes: 0,
    packs: 0,
    windows: 0,
    fingerprint: null,
  })
  assert.equal(storage.listRecords(NAMESPACE).length, 0)
  assert.equal([...storage.blobs.keys()].filter((key) => key.startsWith(NAMESPACE)).length, 0)
})
