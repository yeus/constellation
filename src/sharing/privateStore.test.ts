import assert from 'node:assert/strict'
import test from 'node:test'

import { decryptPrivateState, encryptPrivateState, type PrivateState } from './privateStore.ts'

const state: PrivateState = {
  version: 1,
  privateKey: 'A'.repeat(40),
  shares: [
    {
      url: 'https://example.test/#share=synthetic',
      sourcePrivateKey: 'B'.repeat(40),
      precision: 'approximate',
      capacity: 1,
      publication: 'foreground',
      approximation: {
        latitude: 32.7157,
        longitude: -117.1611,
        radiusMeters: 1_000,
        thresholdMeters: 500,
        beyondThresholdCount: 1,
      },
    },
  ],
  followed: [],
  viewerLabels: [],
}

test('encrypts and restores approximation state without plaintext in the record', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const encrypted = await encryptPrivateState(state, key, () =>
    Uint8Array.from({ length: 12 }, (_, index) => index + 1),
  )
  assert.equal(JSON.stringify(encrypted).includes('32.7157'), false)
  assert.equal(JSON.stringify(encrypted).includes('B'.repeat(40)), false)
  assert.deepEqual(await decryptPrivateState(encrypted, key), state)
})

test('encrypted private state cannot be opened with another key', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const otherKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const encrypted = await encryptPrivateState(state, key)
  await assert.rejects(() => decryptPrivateState(encrypted, otherKey))
})
