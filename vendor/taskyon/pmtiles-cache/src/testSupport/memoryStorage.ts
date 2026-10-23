/* eslint-disable @typescript-eslint/require-await -- the in-memory test double mirrors the Promise-returning storage port */
import {
  PMTILES_CACHE_STORAGE_CHUNK_BYTES,
  concatBytes,
  sha256Digest,
  utf8,
  type PmtilesCacheStorage,
} from '../storage.ts'

interface StoredRecord {
  value: unknown
  contentHash: string
}

interface StoredWrite {
  namespace: string
  id: string
  chunks: Uint8Array<ArrayBuffer>[]
  size: number
}

const keyOf = (namespace: string, id: string | number): string => `${namespace}/${String(id)}`

export interface MemoryPmtilesStorage extends PmtilesCacheStorage {
  readonly records: Map<string, StoredRecord>
  readonly blobs: Map<string, Uint8Array<ArrayBuffer>>
  readonly writes: Map<string, StoredWrite>
  writeChunks: number
  /** Fail this many conditional record writes before succeeding. */
  setIfUnchangedFailures: number
  /** Fail every record/blob read while true. */
  failReads: boolean
  listRecords: (namespace: string) => { id: string; data: unknown }[]
}

export const createMemoryPmtilesStorage = (): MemoryPmtilesStorage => {
  const records = new Map<string, StoredRecord>()
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>()
  const writes = new Map<string, StoredWrite>()
  const storage: MemoryPmtilesStorage = {
    records,
    blobs,
    writes,
    writeChunks: 0,
    setIfUnchangedFailures: 0,
    failReads: false,
    listRecords: (namespace) =>
      [...records.entries()]
        .filter(([key]) => key.startsWith(`${namespace}/`))
        .map(([key, stored]) => ({
          id: key.slice(namespace.length + 1),
          data: stored.value,
        })),
    get: async ({ namespace, id }) => {
      if (storage.failReads) throw new Error('Injected storage read failure.')
      const stored = records.get(keyOf(namespace, id))
      return stored
        ? { value: structuredClone(stored.value), contentHash: stored.contentHash }
        : { value: null, contentHash: null }
    },
    set: async ({ namespace, id, value }) => {
      const contentHash = await sha256Digest(utf8(JSON.stringify(value)))
      records.set(keyOf(namespace, id), { value: structuredClone(value), contentHash })
    },
    getMany: async ({ namespace, ids }) => ({
      rows: ids.flatMap((id) => {
        const stored = records.get(keyOf(namespace, id))
        return stored ? [{ id, data: structuredClone(stored.value) }] : []
      }),
    }),
    setIfUnchanged: async ({ namespace, id, expectedContentHash, value }) => {
      if (storage.setIfUnchangedFailures > 0) {
        storage.setIfUnchangedFailures -= 1
        return { written: false, currentContentHash: expectedContentHash }
      }
      const key = keyOf(namespace, id)
      const current = records.get(key)
      if ((current?.contentHash ?? null) !== expectedContentHash) {
        return { written: false, currentContentHash: current?.contentHash ?? null }
      }
      const contentHash = await sha256Digest(utf8(JSON.stringify(value)))
      records.set(key, { value: structuredClone(value), contentHash })
      return { written: true, currentContentHash: contentHash }
    },
    list: async ({ namespace }) => ({
      rows: storage.listRecords(namespace),
    }),
    delete: async ({ namespace, id }) => {
      records.delete(keyOf(namespace, id))
    },
    getBlob: async ({ namespace, id }) => {
      if (storage.failReads) throw new Error('Injected storage read failure.')
      const data = blobs.get(keyOf(namespace, id))
      return data ? { data: data.slice(), metadata: { size: data.byteLength } } : null
    },
    statBlob: async ({ namespace, id }) => {
      const data = blobs.get(keyOf(namespace, id))
      return data ? { size: data.byteLength } : null
    },
    listBlobs: async ({ namespace }) => ({
      blobs: [...blobs.entries()]
        .filter(([key]) => key.startsWith(`${namespace}/`))
        .map(([key, data]) => ({ id: key.slice(namespace.length + 1), size: data.byteLength })),
    }),
    readBlobRange: async ({ namespace, id, offset, length }) => {
      if (storage.failReads) throw new Error('Injected storage read failure.')
      if (length > PMTILES_CACHE_STORAGE_CHUNK_BYTES)
        throw new RangeError('Range reads must not exceed 1 MiB.')
      const data = blobs.get(keyOf(namespace, id))
      if (!data) throw new Error('Blob not found.')
      const slice = data.slice(offset, Math.min(data.byteLength, offset + length))
      return {
        data: slice,
        nextOffset: offset + slice.byteLength,
        eof: offset + slice.byteLength >= data.byteLength,
      }
    },
    beginBlobWrite: async ({ namespace, id }) => {
      const writeId = `w${writes.size + 1}`
      writes.set(writeId, { namespace, id, chunks: [], size: 0 })
      return { writeId }
    },
    writeBlobChunk: async ({ namespace, id, writeId, offset, data }) => {
      if (data.byteLength > PMTILES_CACHE_STORAGE_CHUNK_BYTES)
        throw new RangeError('Blob chunks must not exceed 1 MiB.')
      const write = writes.get(writeId)
      if (!write || write.namespace !== namespace || write.id !== id)
        throw new Error('Unknown blob write.')
      if (offset !== write.size) throw new Error('Blob writes must be sequential.')
      write.chunks.push(data.slice())
      write.size += data.byteLength
      storage.writeChunks += 1
      return { nextOffset: write.size }
    },
    commitBlobWrite: async ({ namespace, id, writeId, expectedSize, expectedSha256 }) => {
      const write = writes.get(writeId)
      if (!write || write.namespace !== namespace || write.id !== id)
        throw new Error('Unknown blob write.')
      const data = concatBytes(write.chunks)
      if (data.byteLength !== expectedSize) throw new Error('Blob size mismatch.')
      const sha256 = await sha256Digest(data)
      if (expectedSha256 && expectedSha256 !== sha256) throw new Error('Blob checksum mismatch.')
      blobs.set(keyOf(namespace, id), data)
      writes.delete(writeId)
      return { size: data.byteLength }
    },
    abortBlobWrite: async ({ writeId }) => {
      writes.delete(writeId)
    },
    deleteBlob: async ({ namespace, id }) => {
      blobs.delete(keyOf(namespace, id))
    },
  }
  return storage
}
