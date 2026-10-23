import type { PmtilesCacheStorage } from '@taskyon/pmtiles-cache'

import { createIndexedDbPmtilesCacheStorage } from './pmtilesCacheIndexedDb.ts'
import { createOpfsPmtilesCacheStorage } from './pmtilesCacheOpfs.ts'

export type PmtilesCacheBackend = 'opfs' | 'indexeddb'

export interface PmtilesCacheStorageHandle {
  readonly storage: PmtilesCacheStorage
  readonly backend: PmtilesCacheBackend
}

const CACHE_DIRECTORY = 'constellation-pmtiles-cache-v2'
const CACHE_DATABASE = 'constellation-pmtiles-cache-v2'
const LEGACY_DIRECTORY = 'constellation-pmtiles-cache-v1'
const LEGACY_DATABASE = 'constellation-pmtiles-cache-v1'

const removeLegacyOpfsDirectory = async (): Promise<void> => {
  if (!navigator.storage?.getDirectory) return
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(LEGACY_DIRECTORY, { recursive: true })
  } catch {
    // The old cache was disposable public basemap data.
  }
}

const removeLegacyIndexedDb = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve()
      return
    }
    const request = indexedDB.deleteDatabase(LEGACY_DATABASE)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })

const openOpfsStorage = async (): Promise<PmtilesCacheStorage | undefined> => {
  if (!navigator.storage?.getDirectory) return undefined
  if (
    typeof FileSystemFileHandle === 'undefined' ||
    typeof FileSystemFileHandle.prototype.createWritable !== 'function'
  )
    return undefined
  try {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: true })
    return await createOpfsPmtilesCacheStorage(directory)
  } catch {
    return undefined
  }
}

const openIndexedDbStorage = async (): Promise<PmtilesCacheStorage | undefined> => {
  if (typeof indexedDB === 'undefined') return undefined
  try {
    return await createIndexedDbPmtilesCacheStorage(CACHE_DATABASE)
  } catch {
    return undefined
  }
}

export const pmtilesCacheSourceId = async (sourceKey: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceKey))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const createPmtilesCacheStorage = async (): Promise<
  PmtilesCacheStorageHandle | undefined
> => {
  await removeLegacyOpfsDirectory()
  await removeLegacyIndexedDb()
  const opfs = await openOpfsStorage()
  if (opfs) return { storage: opfs, backend: 'opfs' }
  const indexedDb = await openIndexedDbStorage()
  if (indexedDb) return { storage: indexedDb, backend: 'indexeddb' }
  return undefined
}
