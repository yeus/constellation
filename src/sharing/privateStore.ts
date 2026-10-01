import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'

import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'

const ShareRecord = z.object({
  url: z.string().url().max(4_096),
  sourcePrivateKey: z.string().min(40).max(1_024).optional(),
  precision: z.enum(['exact', 'approximate', 'very-coarse']),
  capacity: z.number().int().min(1).max(128),
  name: z.string().max(32).optional(),
  publication: z.enum(['foreground', 'background']),
  battery: z.enum(['balanced', 'saver']).optional(),
  network: z.enum(['always', 'pause-when-metered']).optional(),
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

const EncryptedPrivateStateSchema = z.object({
  iv: z.string(),
  ciphertext: z.string(),
})

const PRIVATE_STATE_ASSOCIATED_DATA = new TextEncoder().encode('constellation-private-state-v1')

export type PrivateState = z.output<typeof PrivateStateSchema>

export interface PrivateStateStore {
  load: () => Promise<PrivateState | undefined>
  save: (state: PrivateState) => Promise<void>
}

export const parsePrivateState = (value: unknown): PrivateState => PrivateStateSchema.parse(value)

export const parsePrivateStateJson = (value: string): PrivateState =>
  parsePrivateState(JSON.parse(value))

export const encryptPrivateState = async (
  state: PrivateState,
  key: CryptoKey,
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): Promise<{ iv: string; ciphertext: string }> => {
  const iv = randomBytes(12)
  if (iv.length !== 12) throw new RangeError('Private-state IV must contain 12 bytes.')
  const plaintext = new TextEncoder().encode(JSON.stringify(PrivateStateSchema.parse(state)))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(iv).buffer,
      additionalData: Uint8Array.from(PRIVATE_STATE_ASSOCIATED_DATA).buffer,
    },
    key,
    plaintext,
  )
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }
}

export const decryptPrivateState = async (
  value: unknown,
  key: CryptoKey,
): Promise<PrivateState> => {
  const payload = EncryptedPrivateStateSchema.parse(value)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(base64UrlToBytes(payload.iv)).buffer,
      additionalData: Uint8Array.from(PRIVATE_STATE_ASSOCIATED_DATA).buffer,
    },
    key,
    new Uint8Array(base64UrlToBytes(payload.ciphertext)),
  )
  return PrivateStateSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)))
}

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
  return {
    load: async (): Promise<PrivateState | undefined> => {
      const opened = await database
      const transaction = opened.transaction('secrets', 'readonly')
      const record = await requestResult(transaction.objectStore('secrets').get('state'))
      if (record === undefined) return undefined
      const key = await getKey(opened)
      return decryptPrivateState(record, key)
    },
    save: async (state: PrivateState): Promise<void> => {
      const opened = await database
      const key = await getKey(opened)
      const encrypted = await encryptPrivateState(state, key)
      const transaction = opened.transaction('secrets', 'readwrite')
      const completed = transactionDone(transaction)
      transaction.objectStore('secrets').put(encrypted, 'state')
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
