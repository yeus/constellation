/**
 * The narrow storage capability required by the sparse PMTiles range cache.
 *
 * A scoped Taskyon `StorageClient` satisfies this interface directly. Hosts
 * that do not embed the Taskyon runtime may implement the same record/blob
 * operations over their existing physical storage; the engine never selects a
 * backend and never sees filesystem or database details.
 */
export interface PmtilesCacheStorage {
  get: (request: {
    namespace: string
    id: string | number
  }) => Promise<{ value: unknown; contentHash: string | null }>
  set: (request: { namespace: string; id: string | number; value: unknown }) => Promise<void>
  getMany: (request: {
    namespace: string
    ids: (string | number)[]
  }) => Promise<{ rows: { id: string | number; data: unknown }[] }>
  setIfUnchanged: (request: {
    namespace: string
    id: string | number
    expectedContentHash: string | null
    value: unknown
  }) => Promise<{ written: boolean; currentContentHash: string | null }>
  list: (request: { namespace: string }) => Promise<{
    rows: { id: string | number; data: unknown }[]
  }>
  delete: (request: { namespace: string; id: string | number }) => Promise<void>
  getBlob: (request: { namespace: string; id: string }) => Promise<{
    data: Uint8Array<ArrayBuffer>
    metadata: { size: number }
  } | null>
  statBlob: (request: { namespace: string; id: string }) => Promise<{ size: number } | null>
  listBlobs: (request: { namespace: string }) => Promise<{
    blobs: { id: string; size: number }[]
  }>
  readBlobRange: (request: {
    namespace: string
    id: string
    offset: number
    length: number
  }) => Promise<{ data: Uint8Array<ArrayBuffer>; nextOffset: number; eof: boolean }>
  beginBlobWrite: (request: {
    namespace: string
    id: string
    contentType?: string
  }) => Promise<{ writeId: string }>
  writeBlobChunk: (request: {
    namespace: string
    id: string
    writeId: string
    offset: number
    data: Uint8Array<ArrayBuffer>
  }) => Promise<{ nextOffset: number }>
  commitBlobWrite: (request: {
    namespace: string
    id: string
    writeId: string
    expectedSize: number
    expectedSha256?: string
  }) => Promise<{ size: number }>
  abortBlobWrite: (request: { namespace: string; id: string; writeId: string }) => Promise<void>
  deleteBlob: (request: { namespace: string; id: string }) => Promise<void>
}

export const PMTILES_CACHE_STORAGE_CHUNK_BYTES = 1024 * 1024

export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value)

export const sha256Digest = async (data: Uint8Array<ArrayBuffer>): Promise<`sha256:${string}`> => {
  const digest = await crypto.subtle.digest('SHA-256', data)
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `sha256:${base64url}`
}

export const base64UrlHashId = (hash: `sha256:${string}`): string => hash.slice('sha256:'.length)

export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const total = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    total.set(chunk, offset)
    offset += chunk.byteLength
  }
  return total
}
