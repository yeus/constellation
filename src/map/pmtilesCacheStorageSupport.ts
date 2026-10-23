import type { PmtilesCacheStorage } from '@taskyon/pmtiles-cache'

export const PMTILES_CACHE_CHUNK_BYTES = 1024 * 1024

export type RecordStorage = Pick<
  PmtilesCacheStorage,
  'get' | 'set' | 'getMany' | 'setIfUnchanged' | 'list' | 'delete'
>

export type BlobStorage = Pick<
  PmtilesCacheStorage,
  | 'getBlob'
  | 'statBlob'
  | 'listBlobs'
  | 'readBlobRange'
  | 'beginBlobWrite'
  | 'writeBlobChunk'
  | 'commitBlobWrite'
  | 'abortBlobWrite'
  | 'deleteBlob'
>

export const joinBytes = (chunks: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> => {
  const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    total.set(chunk, offset)
    offset += chunk.byteLength
  }
  return total
}

export const hashCacheBytes = async (
  data: Uint8Array<ArrayBuffer>,
): Promise<`sha256:${string}`> => {
  const digest = await crypto.subtle.digest('SHA-256', data)
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `sha256:${base64url}`
}

export const hashCacheText = async (value: string): Promise<`sha256:${string}`> =>
  await hashCacheBytes(new TextEncoder().encode(value))

export const withCacheLock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
  const locks = globalThis.navigator?.locks
  return locks ? await locks.request(`constellation:pmtiles:${key}`, operation) : await operation()
}
