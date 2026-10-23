import type { PmtilesCacheStorage } from '@taskyon/pmtiles-cache'

import {
  PMTILES_CACHE_CHUNK_BYTES,
  hashCacheBytes,
  hashCacheText,
  joinBytes,
  withCacheLock,
  type BlobStorage,
  type RecordStorage,
} from './pmtilesCacheStorageSupport.ts'

const RECORDS_DIRECTORY = 'records'
const BLOBS_DIRECTORY = 'blobs'

interface OpfsWrite {
  namespace: string
  id: string
  writable: FileSystemWritableFileStream
  chunks: Uint8Array<ArrayBuffer>[]
  size: number
}

const segment = (value: string): string => encodeURIComponent(value)
const decodeSegment = (value: string): string => decodeURIComponent(value)

const namespaceSegments = (namespace: string): string[] =>
  namespace
    .split('/')
    .filter((entry) => entry.length > 0)
    .map(segment)

const isNotFound = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'NotFoundError'

const directoryAt = async (
  root: FileSystemDirectoryHandle,
  segments: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> => {
  let current = root
  for (const entry of segments) {
    try {
      current = await current.getDirectoryHandle(entry, { create })
    } catch (error) {
      if (!create && isNotFound(error)) return undefined
      throw error
    }
  }
  return current
}

const fileAt = async (
  directory: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
): Promise<FileSystemFileHandle | undefined> => {
  try {
    return await directory.getFileHandle(name, { create })
  } catch (error) {
    if (!create && isNotFound(error)) return undefined
    throw error
  }
}

const removeFile = async (directory: FileSystemDirectoryHandle, name: string): Promise<void> => {
  await directory.removeEntry(name).catch((error: unknown) => {
    if (!isNotFound(error)) throw error
  })
}

const readJson = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
): Promise<{ value: unknown; contentHash: string | null }> => {
  const directory = await directoryAt(
    root,
    [RECORDS_DIRECTORY, ...namespaceSegments(namespace)],
    true,
  )
  if (!directory) return { value: null, contentHash: null }
  const file = await fileAt(directory, `${segment(id)}.json`, false)
  if (!file) return { value: null, contentHash: null }
  const text = await (await file.getFile()).text()
  try {
    return { value: JSON.parse(text), contentHash: await hashCacheText(text) }
  } catch {
    await removeFile(directory, `${segment(id)}.json`)
    return { value: null, contentHash: null }
  }
}

const writeJson = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
  value: unknown,
): Promise<void> => {
  const directory = await directoryAt(
    root,
    [RECORDS_DIRECTORY, ...namespaceSegments(namespace)],
    true,
  )
  if (!directory) throw new Error('Map cache records directory is unavailable.')
  const file = await fileAt(directory, `${segment(id)}.json`, true)
  if (!file) throw new Error('Map cache record file is unavailable.')
  const writable = await file.createWritable()
  await writable.write(JSON.stringify(value))
  await writable.close()
}

const listJson = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
): Promise<{ id: string; data: unknown }[]> => {
  const directory = await directoryAt(
    root,
    [RECORDS_DIRECTORY, ...namespaceSegments(namespace)],
    true,
  )
  if (!directory) return []
  const entries: { id: string; data: unknown }[] = []
  const iterator = (
    directory as FileSystemDirectoryHandle & {
      values(): AsyncIterable<FileSystemHandle>
    }
  ).values()
  for await (const handle of iterator) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    try {
      const file = await directory.getFileHandle(handle.name)
      entries.push({
        id: decodeSegment(handle.name.slice(0, -'.json'.length)),
        data: JSON.parse(await (await file.getFile()).text()),
      })
    } catch {
      // A torn record is disposable public cache metadata.
      await removeFile(directory, handle.name).catch(() => undefined)
    }
  }
  return entries
}

const readRecordMany = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  ids: readonly (string | number)[],
): Promise<{ rows: { id: string | number; data: unknown }[] }> => {
  const rows: { id: string | number; data: unknown }[] = []
  for (const id of ids) {
    const stored = await readJson(root, namespace, String(id))
    if (stored.value !== null) rows.push({ id, data: stored.value })
  }
  return { rows }
}

const writeRecordIfUnchanged = async (
  root: FileSystemDirectoryHandle,
  request: Parameters<PmtilesCacheStorage['setIfUnchanged']>[0],
): Promise<{ written: boolean; currentContentHash: string | null }> =>
  await withCacheLock(`${request.namespace}/${String(request.id)}`, async () => {
    const current = await readJson(root, request.namespace, String(request.id))
    if (current.contentHash !== request.expectedContentHash)
      return { written: false, currentContentHash: current.contentHash }
    await writeJson(root, request.namespace, String(request.id), request.value)
    return {
      written: true,
      currentContentHash: await hashCacheText(JSON.stringify(request.value)),
    }
  })

const deleteRecord = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string | number,
): Promise<void> => {
  await withCacheLock(`${namespace}/${String(id)}`, async () => {
    const target = await directoryAt(
      root,
      [RECORDS_DIRECTORY, ...namespaceSegments(namespace)],
      false,
    )
    if (target) await removeFile(target, `${segment(String(id))}.json`)
  })
}

const createOpfsRecordStorage = (directory: FileSystemDirectoryHandle): RecordStorage => ({
  get: ({ namespace, id }) => readJson(directory, namespace, String(id)),
  set: async ({ namespace, id, value }) => {
    await withCacheLock(`${namespace}/${String(id)}`, async () => {
      await writeJson(directory, namespace, String(id), value)
    })
  },
  getMany: ({ namespace, ids }) => readRecordMany(directory, namespace, ids),
  setIfUnchanged: (request) => writeRecordIfUnchanged(directory, request),
  list: async ({ namespace }) => ({ rows: await listJson(directory, namespace) }),
  delete: ({ namespace, id }) => deleteRecord(directory, namespace, id),
})

const blobPath = (namespace: string, id: string) => [
  BLOBS_DIRECTORY,
  ...namespaceSegments(namespace),
  segment(id),
]

const readBlobFile = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
  create: boolean,
): Promise<FileSystemFileHandle | undefined> => {
  const directory = await directoryAt(root, blobPath(namespace, id).slice(0, -1), create)
  if (!directory) return undefined
  return await fileAt(directory, segment(id), create)
}

const readBlob = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
): Promise<{ data: Uint8Array<ArrayBuffer>; size: number } | null> => {
  const file = await readBlobFile(root, namespace, id, false)
  if (!file) return null
  const content = await file.getFile()
  return { data: new Uint8Array(await content.arrayBuffer()), size: content.size }
}

const listBlobMetadata = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
): Promise<{ blobs: { id: string; size: number }[] }> => {
  const directory = await directoryAt(
    root,
    [BLOBS_DIRECTORY, ...namespaceSegments(namespace)],
    true,
  )
  if (!directory) return { blobs: [] }
  const blobs: { id: string; size: number }[] = []
  const iterator = (
    directory as FileSystemDirectoryHandle & {
      values(): AsyncIterable<FileSystemHandle>
    }
  ).values()
  for await (const handle of iterator) {
    if (handle.kind !== 'file') continue
    const file = await directory.getFileHandle(handle.name)
    blobs.push({ id: decodeSegment(handle.name), size: (await file.getFile()).size })
  }
  return { blobs }
}

const readBlobRange = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
  offset: number,
  length: number,
): Promise<{ data: Uint8Array<ArrayBuffer>; nextOffset: number; eof: boolean }> => {
  if (length > PMTILES_CACHE_CHUNK_BYTES) throw new RangeError('Range reads must not exceed 1 MiB.')
  const file = await readBlobFile(root, namespace, id, false)
  if (!file) throw new Error('Map cache blob not found.')
  const content = await file.getFile()
  const end = Math.min(content.size, offset + length)
  const data = new Uint8Array(await content.slice(offset, end).arrayBuffer())
  return { data, nextOffset: offset + data.byteLength, eof: end >= content.size }
}

const beginWrite = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
  writes: Map<string, OpfsWrite>,
): Promise<{ writeId: string }> => {
  const file = await readBlobFile(root, namespace, id, true)
  if (!file) throw new Error('Map cache blob file is unavailable.')
  const writable = await file.createWritable({ keepExistingData: false })
  const writeId = crypto.randomUUID()
  writes.set(writeId, { namespace, id, writable, chunks: [], size: 0 })
  return { writeId }
}

const requireWrite = (
  writes: Map<string, OpfsWrite>,
  namespace: string,
  id: string,
  writeId: string,
): OpfsWrite => {
  const write = writes.get(writeId)
  if (!write || write.namespace !== namespace || write.id !== id)
    throw new Error('Unknown map cache blob write.')
  return write
}

const writeBlobChunk = async (
  writes: Map<string, OpfsWrite>,
  request: Parameters<PmtilesCacheStorage['writeBlobChunk']>[0],
): Promise<{ nextOffset: number }> => {
  if (request.data.byteLength > PMTILES_CACHE_CHUNK_BYTES)
    throw new RangeError('Blob chunks must not exceed 1 MiB.')
  const write = requireWrite(writes, request.namespace, request.id, request.writeId)
  if (request.offset !== write.size) throw new Error('Blob writes must be sequential.')
  const copy = request.data.slice()
  await write.writable.write(copy)
  write.chunks.push(copy)
  write.size += copy.byteLength
  return { nextOffset: write.size }
}

const removeBlob = async (
  root: FileSystemDirectoryHandle,
  namespace: string,
  id: string,
): Promise<void> => {
  const parent = await directoryAt(root, [BLOBS_DIRECTORY, ...namespaceSegments(namespace)], false)
  if (parent) await removeFile(parent, segment(id))
}

const commitBlobWrite = async (
  root: FileSystemDirectoryHandle,
  writes: Map<string, OpfsWrite>,
  request: Parameters<PmtilesCacheStorage['commitBlobWrite']>[0],
): Promise<{ size: number }> => {
  const write = requireWrite(writes, request.namespace, request.id, request.writeId)
  try {
    await write.writable.close()
    if (write.size !== request.expectedSize) throw new Error('Blob size mismatch.')
    const sha256 = await hashCacheBytes(joinBytes(write.chunks))
    if (request.expectedSha256 && request.expectedSha256 !== sha256)
      throw new Error('Blob checksum mismatch.')
    return { size: write.size }
  } catch (error) {
    await removeBlob(root, request.namespace, request.id).catch(() => undefined)
    throw error
  } finally {
    writes.delete(request.writeId)
  }
}

const abortBlobWrite = async (
  root: FileSystemDirectoryHandle,
  writes: Map<string, OpfsWrite>,
  namespace: string,
  id: string,
  writeId: string,
): Promise<void> => {
  const write = writes.get(writeId)
  writes.delete(writeId)
  if (!write) return
  await write.writable.abort().catch(() => undefined)
  await removeBlob(root, namespace, id)
}

const createOpfsBlobStorage = (directory: FileSystemDirectoryHandle): BlobStorage => {
  const writes = new Map<string, OpfsWrite>()
  return {
    getBlob: async ({ namespace, id }) => {
      const blob = await readBlob(directory, namespace, id)
      return blob ? { data: blob.data, metadata: { size: blob.size } } : null
    },
    statBlob: async ({ namespace, id }) => {
      const blob = await readBlob(directory, namespace, id)
      return blob ? { size: blob.size } : null
    },
    listBlobs: ({ namespace }) => listBlobMetadata(directory, namespace),
    readBlobRange: ({ namespace, id, offset, length }) =>
      readBlobRange(directory, namespace, id, offset, length),
    beginBlobWrite: ({ namespace, id }) => beginWrite(directory, namespace, id, writes),
    writeBlobChunk: (request) => writeBlobChunk(writes, request),
    commitBlobWrite: (request) => commitBlobWrite(directory, writes, request),
    abortBlobWrite: ({ namespace, id, writeId }) =>
      abortBlobWrite(directory, writes, namespace, id, writeId),
    deleteBlob: ({ namespace, id }) => removeBlob(directory, namespace, id),
  }
}

export const createOpfsPmtilesCacheStorage = (
  directory: FileSystemDirectoryHandle,
): Promise<PmtilesCacheStorage> =>
  Promise.resolve({
    ...createOpfsRecordStorage(directory),
    ...createOpfsBlobStorage(directory),
  })
