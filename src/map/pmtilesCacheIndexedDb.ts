import type { PmtilesCacheStorage } from '@taskyon/pmtiles-cache'

import {
  PMTILES_CACHE_CHUNK_BYTES,
  hashCacheBytes,
  hashCacheText,
  joinBytes,
  type BlobStorage,
  type RecordStorage,
} from './pmtilesCacheStorageSupport.ts'

const RECORDS_STORE = 'records'
const BLOBS_STORE = 'blobs'

interface StoredRecord {
  value: unknown
  contentHash: `sha256:${string}`
}

interface StoredBlob {
  blob: Blob
  size: number
  contentType?: string
  sha256?: `sha256:${string}`
}

interface IndexedDbWrite {
  namespace: string
  id: string
  chunks: Uint8Array<ArrayBuffer>[]
  size: number
  contentType?: string
}

const keyOf = (namespace: string, id: string | number): string => `${namespace}/${String(id)}`
const prefixRange = (namespace: string): IDBKeyRange =>
  IDBKeyRange.bound(`${namespace}/`, `${namespace}/\uffff`)

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Map cache request failed.'))
  })

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Map cache write failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Map cache write aborted.'))
  })

const openDatabase = (name: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(RECORDS_STORE))
        database.createObjectStore(RECORDS_STORE)
      if (!database.objectStoreNames.contains(BLOBS_STORE)) database.createObjectStore(BLOBS_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Map cache could not open.'))
  })

const readRecord = async (
  database: IDBDatabase,
  namespace: string,
  id: string | number,
): Promise<StoredRecord | undefined> => {
  const transaction = database.transaction(RECORDS_STORE, 'readonly')
  return await requestResult(
    transaction.objectStore(RECORDS_STORE).get(keyOf(namespace, id)) as IDBRequest<
      StoredRecord | undefined
    >,
  )
}

const writeRecord = async (
  database: IDBDatabase,
  namespace: string,
  id: string | number,
  value: unknown,
): Promise<void> => {
  const contentHash = await hashCacheText(JSON.stringify(value))
  const transaction = database.transaction(RECORDS_STORE, 'readwrite')
  const completed = transactionDone(transaction)
  transaction.objectStore(RECORDS_STORE).put({ value, contentHash }, keyOf(namespace, id))
  await completed
}

const readRecordMany = async (
  database: IDBDatabase,
  namespace: string,
  ids: readonly (string | number)[],
): Promise<{ rows: { id: string | number; data: unknown }[] }> => {
  const transaction = database.transaction(RECORDS_STORE, 'readonly')
  const store = transaction.objectStore(RECORDS_STORE)
  const records = await Promise.all(
    ids.map(
      async (id) =>
        [
          id,
          await requestResult(
            store.get(keyOf(namespace, id)) as IDBRequest<StoredRecord | undefined>,
          ),
        ] as const,
    ),
  )
  return {
    rows: records.flatMap(([id, record]) => (record ? [{ id, data: record.value }] : [])),
  }
}

const writeRecordIfUnchanged = async (
  database: IDBDatabase,
  request: Parameters<PmtilesCacheStorage['setIfUnchanged']>[0],
): Promise<{ written: boolean; currentContentHash: string | null }> => {
  const contentHash = await hashCacheText(JSON.stringify(request.value))
  const transaction = database.transaction(RECORDS_STORE, 'readwrite')
  const store = transaction.objectStore(RECORDS_STORE)
  const current = await requestResult(
    store.get(keyOf(request.namespace, request.id)) as IDBRequest<StoredRecord | undefined>,
  )
  const currentContentHash = current?.contentHash ?? null
  if (currentContentHash !== request.expectedContentHash) {
    transaction.abort()
    return { written: false, currentContentHash }
  }
  store.put({ value: request.value, contentHash }, keyOf(request.namespace, request.id))
  await transactionDone(transaction)
  return { written: true, currentContentHash }
}

const listRecords = async (
  database: IDBDatabase,
  namespace: string,
): Promise<{ rows: { id: string | number; data: unknown }[] }> => {
  const transaction = database.transaction(RECORDS_STORE, 'readonly')
  const store = transaction.objectStore(RECORDS_STORE)
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys(prefixRange(namespace))),
    requestResult(store.getAll(prefixRange(namespace)) as IDBRequest<StoredRecord[]>),
  ])
  return {
    rows: values.flatMap((record, index) => {
      const key = keys[index]
      return typeof key === 'string'
        ? [{ id: key.slice(namespace.length + 1), data: record.value }]
        : []
    }),
  }
}

const deleteRecord = async (
  database: IDBDatabase,
  namespace: string,
  id: string | number,
): Promise<void> => {
  const transaction = database.transaction(RECORDS_STORE, 'readwrite')
  const completed = transactionDone(transaction)
  transaction.objectStore(RECORDS_STORE).delete(keyOf(namespace, id))
  await completed
}

const createIdbRecordStorage = (database: IDBDatabase): RecordStorage => ({
  get: async ({ namespace, id }) => {
    const record = await readRecord(database, namespace, id)
    return record
      ? { value: record.value, contentHash: record.contentHash }
      : { value: null, contentHash: null }
  },
  set: async ({ namespace, id, value }) => {
    await writeRecord(database, namespace, id, value)
  },
  getMany: ({ namespace, ids }) => readRecordMany(database, namespace, ids),
  setIfUnchanged: (request) => writeRecordIfUnchanged(database, request),
  list: ({ namespace }) => listRecords(database, namespace),
  delete: ({ namespace, id }) => deleteRecord(database, namespace, id),
})

const readBlob = async (
  database: IDBDatabase,
  namespace: string,
  id: string,
): Promise<StoredBlob | undefined> => {
  const transaction = database.transaction(BLOBS_STORE, 'readonly')
  return await requestResult(
    transaction.objectStore(BLOBS_STORE).get(keyOf(namespace, id)) as IDBRequest<
      StoredBlob | undefined
    >,
  )
}

const getBlob = async (
  database: IDBDatabase,
  namespace: string,
  id: string,
): Promise<{ data: Uint8Array<ArrayBuffer>; metadata: { size: number } } | null> => {
  const stored = await readBlob(database, namespace, id)
  if (!stored) return null
  return {
    data: new Uint8Array(await stored.blob.arrayBuffer()),
    metadata: { size: stored.size },
  }
}

const statBlob = async (
  database: IDBDatabase,
  namespace: string,
  id: string,
): Promise<{ size: number } | null> => {
  const stored = await readBlob(database, namespace, id)
  return stored ? { size: stored.size } : null
}

const listBlobMetadata = async (
  database: IDBDatabase,
  namespace: string,
): Promise<{ blobs: { id: string; size: number }[] }> => {
  const transaction = database.transaction(BLOBS_STORE, 'readonly')
  const store = transaction.objectStore(BLOBS_STORE)
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys(prefixRange(namespace))),
    requestResult(store.getAll(prefixRange(namespace)) as IDBRequest<StoredBlob[]>),
  ])
  return {
    blobs: values.flatMap((stored, index) => {
      const key = keys[index]
      return typeof key === 'string'
        ? [{ id: key.slice(namespace.length + 1), size: stored.size }]
        : []
    }),
  }
}

const readBlobRange = async (
  database: IDBDatabase,
  namespace: string,
  id: string,
  offset: number,
  length: number,
): Promise<{ data: Uint8Array<ArrayBuffer>; nextOffset: number; eof: boolean }> => {
  if (length > PMTILES_CACHE_CHUNK_BYTES) throw new RangeError('Range reads must not exceed 1 MiB.')
  const stored = await readBlob(database, namespace, id)
  if (!stored) throw new Error('Map cache blob not found.')
  const end = Math.min(stored.size, offset + length)
  const data = new Uint8Array(await stored.blob.slice(offset, end).arrayBuffer())
  return { data, nextOffset: offset + data.byteLength, eof: end >= stored.size }
}

const beginBlobWrite = (
  writes: Map<string, IndexedDbWrite>,
  request: Parameters<PmtilesCacheStorage['beginBlobWrite']>[0],
): Promise<{ writeId: string }> => {
  const writeId = crypto.randomUUID()
  writes.set(writeId, {
    namespace: request.namespace,
    id: request.id,
    chunks: [],
    size: 0,
    ...(request.contentType ? { contentType: request.contentType } : {}),
  })
  return Promise.resolve({ writeId })
}

const writeBlobChunk = (
  writes: Map<string, IndexedDbWrite>,
  request: Parameters<PmtilesCacheStorage['writeBlobChunk']>[0],
): Promise<{ nextOffset: number }> => {
  if (request.data.byteLength > PMTILES_CACHE_CHUNK_BYTES)
    throw new RangeError('Blob chunks must not exceed 1 MiB.')
  const write = writes.get(request.writeId)
  if (!write || write.namespace !== request.namespace || write.id !== request.id)
    throw new Error('Unknown map cache blob write.')
  if (request.offset !== write.size) throw new Error('Blob writes must be sequential.')
  write.chunks.push(request.data.slice())
  write.size += request.data.byteLength
  return Promise.resolve({ nextOffset: write.size })
}

const commitBlobWrite = async (
  database: IDBDatabase,
  writes: Map<string, IndexedDbWrite>,
  request: Parameters<PmtilesCacheStorage['commitBlobWrite']>[0],
): Promise<{ size: number }> => {
  const write = writes.get(request.writeId)
  if (!write || write.namespace !== request.namespace || write.id !== request.id)
    throw new Error('Unknown map cache blob write.')
  writes.delete(request.writeId)
  if (write.size !== request.expectedSize) throw new Error('Blob size mismatch.')
  const data = joinBytes(write.chunks)
  const sha256 = await hashCacheBytes(data)
  if (request.expectedSha256 && request.expectedSha256 !== sha256)
    throw new Error('Blob checksum mismatch.')
  const transaction = database.transaction(BLOBS_STORE, 'readwrite')
  const completed = transactionDone(transaction)
  transaction.objectStore(BLOBS_STORE).put(
    {
      blob: new Blob([data], { type: write.contentType ?? 'application/octet-stream' }),
      size: data.byteLength,
      sha256,
      ...(write.contentType ? { contentType: write.contentType } : {}),
    } satisfies StoredBlob,
    keyOf(request.namespace, request.id),
  )
  await completed
  return { size: data.byteLength }
}

const abortBlobWrite = (writes: Map<string, IndexedDbWrite>, writeId: string): Promise<void> => {
  writes.delete(writeId)
  return Promise.resolve()
}

const deleteBlob = async (database: IDBDatabase, namespace: string, id: string): Promise<void> => {
  const transaction = database.transaction(BLOBS_STORE, 'readwrite')
  const completed = transactionDone(transaction)
  transaction.objectStore(BLOBS_STORE).delete(keyOf(namespace, id))
  await completed
}

const createIdbBlobStorage = (database: IDBDatabase): BlobStorage => {
  const writes = new Map<string, IndexedDbWrite>()
  return {
    getBlob: ({ namespace, id }) => getBlob(database, namespace, id),
    statBlob: ({ namespace, id }) => statBlob(database, namespace, id),
    listBlobs: ({ namespace }) => listBlobMetadata(database, namespace),
    readBlobRange: ({ namespace, id, offset, length }) =>
      readBlobRange(database, namespace, id, offset, length),
    beginBlobWrite: (request) => beginBlobWrite(writes, request),
    writeBlobChunk: (request) => writeBlobChunk(writes, request),
    commitBlobWrite: (request) => commitBlobWrite(database, writes, request),
    abortBlobWrite: ({ writeId }) => abortBlobWrite(writes, writeId),
    deleteBlob: ({ namespace, id }) => deleteBlob(database, namespace, id),
  }
}

export const createIndexedDbPmtilesCacheStorage = async (
  databaseName: string,
): Promise<PmtilesCacheStorage> => {
  const database = await openDatabase(databaseName)
  return {
    ...createIdbRecordStorage(database),
    ...createIdbBlobStorage(database),
  }
}
