import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'

import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'

const ShareRecord = z.object({
  url: z.string().url().max(4_096),
  precision: z.enum(['exact', 'approximate', 'very-coarse']),
  capacity: z.number().int().min(1).max(128),
  name: z.string().max(32).optional(),
  publication: z.enum(['foreground', 'background']),
  blockedPeerIds: z.array(z.string().min(10).max(200)).max(128).optional(),
  approximation: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusMeters: z.number().positive(),
      thresholdMeters: z.number().positive(),
      beyondThresholdCount: z.number().int().min(0),
    })
    .optional(),
})

const FollowRecord = z.object({
  url: z.string().url().max(4_096),
  localName: z.string().max(32),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  followedAt: z.number().int().positive().optional(),
})

const ViewerLabelRecord = z.object({
  shareId: z.string().min(16).max(64),
  fingerprint: z.string().min(1).max(32),
  name: z.string().min(1).max(32),
})

const PrivateStateSchema = z.object({
  version: z.literal(1),
  privateKey: z.string().min(40).max(1_024),
  shares: z.array(ShareRecord).max(128),
  followed: z.array(FollowRecord).max(128),
  viewerLabels: z.array(ViewerLabelRecord).max(1_024).optional(),
})

export type PrivateState = z.output<typeof PrivateStateSchema>

export interface PrivateStateStore {
  load: () => Promise<PrivateState | undefined>
  save: (state: PrivateState) => Promise<void>
}

export const parsePrivateState = (value: unknown): PrivateState => PrivateStateSchema.parse(value)

export const parsePrivateStateJson = (value: string): PrivateState =>
  parsePrivateState(JSON.parse(value))

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Private storage request failed.'))
  })

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Private storage transaction failed.'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Private storage transaction was aborted.'))
  })

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('constellation-private-v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('secrets')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Private storage could not open.'))
  })

const getKey = async (database: IDBDatabase): Promise<CryptoKey> => {
  const existing = await requestResult(
    database.transaction('secrets', 'readonly').objectStore('secrets').get('key'),
  )
  if (existing instanceof CryptoKey) return existing
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const transaction = database.transaction('secrets', 'readwrite')
  const completed = transactionDone(transaction)
  const store = transaction.objectStore('secrets')
  const concurrent = await requestResult(store.get('key'))
  if (concurrent instanceof CryptoKey) {
    await completed
    return concurrent
  }
  const state = await requestResult(store.get('state'))
  if (state !== undefined) throw new Error('Protected share key is unavailable.')
  store.put(generated, 'key')
  await completed
  return generated
}

export const createBrowserPrivateStore = () => {
  const database = openDatabase()
  const associatedData = new TextEncoder().encode('constellation-private-state-v1')
  return {
    load: async (): Promise<PrivateState | undefined> => {
      const opened = await database
      const transaction = opened.transaction('secrets', 'readonly')
      const record = await requestResult(transaction.objectStore('secrets').get('state'))
      if (record === undefined) return undefined
      const key = await getKey(opened)
      const payload = z.object({ iv: z.string(), ciphertext: z.string() }).parse(record)
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(base64UrlToBytes(payload.iv)),
          additionalData: associatedData,
        },
        key,
        new Uint8Array(base64UrlToBytes(payload.ciphertext)),
      )
      return PrivateStateSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)))
    },
    save: async (state: PrivateState): Promise<void> => {
      const opened = await database
      const key = await getKey(opened)
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const plaintext = new TextEncoder().encode(JSON.stringify(PrivateStateSchema.parse(state)))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: associatedData },
        key,
        plaintext,
      )
      const transaction = opened.transaction('secrets', 'readwrite')
      const completed = transactionDone(transaction)
      transaction.objectStore('secrets').put(
        {
          iv: bytesToBase64Url(iv),
          ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
        },
        'state',
      )
      await completed
    },
  }
}

export const createNativePrivateStore = (platform: 'android' | 'desktop') => ({
  load: async (): Promise<PrivateState | undefined> => {
    const response = await invoke<{ state: string }>(`${platform}_load_private_state`)
    return response.state ? PrivateStateSchema.parse(JSON.parse(response.state)) : undefined
  },
  save: async (state: PrivateState): Promise<void> => {
    await invoke(`${platform}_save_private_state`, {
      state: JSON.stringify(PrivateStateSchema.parse(state)),
    })
  },
})
