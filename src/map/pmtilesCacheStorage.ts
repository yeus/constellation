import type { PmTilesCacheStorage, PmTilesCacheWrite } from '@taskyon/pmtiles-cache'

export type PmtilesCacheBackend = 'opfs' | 'indexeddb'

export interface PmtilesCacheStorageHandle {
  readonly storage: PmTilesCacheStorage
  readonly backend: PmtilesCacheBackend
}

const OPFS_DIRECTORY = 'constellation-pmtiles-cache-v1'
const INDEXED_DB_NAME = 'constellation-pmtiles-cache-v1'
const INDEXED_DB_STORE = 'files'

const cacheKey = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const isNotFound = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'NotFoundError'

const readOpfsFile = async (
  directory: FileSystemDirectoryHandle,
  key: string,
): Promise<Uint8Array | undefined> => {
  try {
    const handle = await directory.getFileHandle(await cacheKey(key))
    return new Uint8Array(await (await handle.getFile()).arrayBuffer())
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

const writeOpfsChunk = async (
  writable: FileSystemWritableFileStream,
  data: Uint8Array,
): Promise<void> => {
  const copy = new Uint8Array(data.length)
  copy.set(data)
  await writable.write(copy)
}

const commitOpfsWrite = async (
  directory: FileSystemDirectoryHandle,
  name: string,
  temporaryName: string,
  writable: FileSystemWritableFileStream,
): Promise<void> => {
  await writable.close()
  try {
    const source = await (await directory.getFileHandle(temporaryName)).getFile()
    const destination = await directory.getFileHandle(name, { create: true })
    const stream = await destination.createWritable()
    await stream.write(source)
    await stream.close()
  } finally {
    await directory.removeEntry(temporaryName).catch(() => undefined)
  }
}

const abortOpfsWrite = async (
  directory: FileSystemDirectoryHandle,
  temporaryName: string,
  writable: FileSystemWritableFileStream,
): Promise<void> => {
  await writable.abort().catch(() => undefined)
  await directory.removeEntry(temporaryName).catch(() => undefined)
}

const beginOpfsWrite = async (
  directory: FileSystemDirectoryHandle,
  key: string,
): Promise<PmTilesCacheWrite> => {
  const name = await cacheKey(key)
  const temporaryName = `${name}.${crypto.randomUUID()}.tmp`
  const temporary = await directory.getFileHandle(temporaryName, { create: true })
  const writable = await temporary.createWritable()
  return {
    write: (data) => writeOpfsChunk(writable, data),
    commit: () => commitOpfsWrite(directory, name, temporaryName, writable),
    abort: () => abortOpfsWrite(directory, temporaryName, writable),
  }
}

const removeOpfsFile = async (directory: FileSystemDirectoryHandle, key: string): Promise<void> => {
  await directory.removeEntry(await cacheKey(key)).catch((error: unknown) => {
    if (!isNotFound(error)) throw error
  })
}

const createOpfsStorage = (directory: FileSystemDirectoryHandle): PmTilesCacheStorage => ({
  read: (key) => readOpfsFile(directory, key),
  beginWrite: (key) => beginOpfsWrite(directory, key),
  remove: (key) => removeOpfsFile(directory, key),
})

const openIndexedDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEXED_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(INDEXED_DB_STORE)) {
        request.result.createObjectStore(INDEXED_DB_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Map cache could not open.'))
  })

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

const readIndexedDbValue = async (
  database: IDBDatabase,
  key: string,
): Promise<Uint8Array | undefined> => {
  const transaction = database.transaction(INDEXED_DB_STORE, 'readonly')
  const stored = await requestResult(
    transaction.objectStore(INDEXED_DB_STORE).get(key) as IDBRequest<ArrayBuffer | undefined>,
  )
  return stored === undefined ? undefined : new Uint8Array(stored)
}

const concatChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    total.set(chunk, offset)
    offset += chunk.length
  }
  return total
}

const writeIndexedDbValue = async (
  database: IDBDatabase,
  key: string,
  value: Uint8Array,
): Promise<void> => {
  const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite')
  const completed = transactionDone(transaction)
  transaction.objectStore(INDEXED_DB_STORE).put(value.buffer, key)
  await completed
}

const beginIndexedDbWrite = (database: IDBDatabase, key: string): PmTilesCacheWrite => {
  let chunks: Uint8Array[] = []
  return {
    write: (data) => {
      chunks.push(data.slice())
      return Promise.resolve()
    },
    commit: async () => {
      await writeIndexedDbValue(database, key, concatChunks(chunks))
      chunks = []
    },
    abort: () => {
      chunks = []
      return Promise.resolve()
    },
  }
}

const removeIndexedDbValue = async (database: IDBDatabase, key: string): Promise<void> => {
  const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite')
  const completed = transactionDone(transaction)
  transaction.objectStore(INDEXED_DB_STORE).delete(key)
  await completed
}

const createIndexedDbStorage = (database: IDBDatabase): PmTilesCacheStorage => ({
  read: (key) => readIndexedDbValue(database, key),
  beginWrite: (key) => Promise.resolve(beginIndexedDbWrite(database, key)),
  remove: (key) => removeIndexedDbValue(database, key),
})

export const createPmtilesCacheStorage = async (): Promise<
  PmtilesCacheStorageHandle | undefined
> => {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true })
      return { storage: createOpfsStorage(directory), backend: 'opfs' }
    }
  } catch {
    // Fall through to IndexedDB when OPFS is exposed but unavailable.
  }
  try {
    if (typeof indexedDB === 'undefined') return undefined
    const database = await openIndexedDb()
    return { storage: createIndexedDbStorage(database), backend: 'indexeddb' }
  } catch {
    return undefined
  }
}
