import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decryptPrivateState,
  encryptPrivateState,
  parsePrivateState,
  type PrivateState,
} from './privateStore.ts'

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

test('preserves return approval, prompt history and old-share lifecycle records', () => {
  const current = parsePrivateState({
    ...state,
    followed: [
      {
        url: 'https://example.test/#share=synthetic',
        localName: 'River',
        color: '#438ec9',
        returnPromptSeen: true,
        terminal: 'revoked',
        endedAt: 1000,
      },
    ],
    approvedReturnLinks: ['synthetic-share-id'],
    pendingReturns: [{ shareId: 'synthetic-share-id', url: 'https://example.test/#share=return' }],
    oldSeeing: [{ shareId: 'synthetic-share-id', name: 'River', reason: 'revoked', endedAt: 1000 }],
    oldSharing: [
      { shareId: 'synthetic-share-id', name: 'River', reason: 'expired', endedAt: 2000 },
    ],
  })
  assert.equal(current.followed[0]?.returnPromptSeen, true)
  assert.deepEqual(current.approvedReturnLinks, ['synthetic-share-id'])
  assert.equal(current.pendingReturns?.length, 1)
  assert.equal(current.oldSeeing?.[0]?.reason, 'revoked')
  assert.equal(current.oldSharing?.[0]?.reason, 'expired')
})

test('share battery and network policy stay optional for existing protected state', () => {
  const legacy = parsePrivateState({
    version: 1,
    privateKey: 'A'.repeat(40),
    shares: [
      {
        url: 'https://example.test/#share=synthetic',
        precision: 'approximate',
        capacity: 1,
        publication: 'background',
      },
    ],
    followed: [],
    viewerLabels: [],
  })
  assert.equal(legacy.shares[0]?.battery, undefined)
  assert.equal(legacy.shares[0]?.network, undefined)

  const current = parsePrivateState({
    ...legacy,
    shares: [
      {
        ...legacy.shares[0],
        battery: 'saver',
        network: 'pause-when-metered',
      },
    ],
  })
  assert.equal(current.shares[0]?.battery, 'saver')
  assert.equal(current.shares[0]?.network, 'pause-when-metered')
})

test('preserves protected ended-link notification endpoints', () => {
  const endedShares = [
    {
      url: 'https://example.test/#share=synthetic',
      sourcePrivateKey: 'A'.repeat(64),
      publication: 'background',
      reason: 'revoked',
      endedAt: 1000,
    },
  ]
  assert.deepEqual(parsePrivateState({ ...state, endedShares }).endedShares, endedShares)
})
