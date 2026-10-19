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

const createOpfsStorage = (directory: FileSystemDirectoryHandle): PmTilesCacheStorage => ({
  read: async (key) => {
    try {
      const handle = await directory.getFileHandle(await cacheKey(key))
      return new Uint8Array(await (await handle.getFile()).arrayBuffer())
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  },
  beginWrite: async (key): Promise<PmTilesCacheWrite> => {
    const name = await cacheKey(key)
    const temporaryName = `${name}.${crypto.randomUUID()}.tmp`
    const temporary = await directory.getFileHandle(temporaryName, { create: true })
    const writable = await temporary.createWritable()
    return {
      write: async (data) => {
        const copy = new Uint8Array(data.length)
        copy.set(data)
        await writable.write(copy)
      },
      commit: async () => {
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
      },
      abort: async () => {
        await writable.abort().catch(() => undefined)
        await directory.removeEntry(temporaryName).catch(() => undefined)
      },
    }
  },
  remove: async (key) => {
    await directory.removeEntry(await cacheKey(key)).catch((error: unknown) => {
      if (!isNotFound(error)) throw error
    })
  },
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

const createIndexedDbStorage = (database: IDBDatabase): PmTilesCacheStorage => ({
  read: async (key) => {
    const transaction = database.transaction(INDEXED_DB_STORE, 'readonly')
    const stored = await requestResult(
      transaction.objectStore(INDEXED_DB_STORE).get(key) as IDBRequest<ArrayBuffer | undefined>,
    )
    return stored === undefined ? undefined : new Uint8Array(stored)
  },
  beginWrite: (key): Promise<PmTilesCacheWrite> => {
    let chunks: Uint8Array[] = []
    return Promise.resolve({
      write: (data) => {
        chunks.push(data.slice())
        return Promise.resolve()
      },
      commit: async () => {
        const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) {
          total.set(chunk, offset)
          offset += chunk.length
        }
        const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite')
        const completed = transactionDone(transaction)
        transaction.objectStore(INDEXED_DB_STORE).put(total.buffer, key)
        await completed
        chunks = []
      },
      abort: () => {
        chunks = []
        return Promise.resolve()
      },
    })
  },
  remove: async (key) => {
    const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite')
    const completed = transactionDone(transaction)
    transaction.objectStore(INDEXED_DB_STORE).delete(key)
    await completed
  },
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
