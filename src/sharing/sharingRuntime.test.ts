import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { bytesToBase64Url } from './encoding.ts'
import { createShareInvitation } from './shareLink.ts'
import type { PrivateState } from './privateStore.ts'

import { createBrowserLocationSource } from '../location/browser.ts'
import {
  appendSessionEvent,
  followStatusFor,
  createSharingRuntime,
  generatedFollowName,
  rememberRedeemedNonce,
  savedFollowRecords,
  sessionSweepReason,
  type SharingRuntimeState,
} from './sharingRuntime.ts'

test('session diagnostics are bounded and contain only safe lifecycle details', () => {
  let events: ReturnType<typeof appendSessionEvent> = []
  events = appendSessionEvent(events, {
    sequence: 0,
    at: 999,
    event: 'stream-open',
    activeSessions: 0,
  })
  for (let index = 0; index < 40; index += 1) {
    events = appendSessionEvent(events, {
      sequence: index + 1,
      at: 1_000 + index,
      event: 'heartbeat-timeout',
      activeSessions: 1,
    })
  }
  assert.equal(events.length, 32)
  assert.equal(events[0]?.sequence, 9)
  assert.deepEqual(Object.keys(events[0] ?? {}).sort(), [
    'activeSessions',
    'at',
    'event',
    'sequence',
  ])
})

test('bounds remembered redemption nonces and preserves recent entries', () => {
  const nonces = new Set<string>()

  rememberRedeemedNonce(nonces, 'first', 2)
  rememberRedeemedNonce(nonces, 'second', 2)
  rememberRedeemedNonce(nonces, 'third', 2)

  assert.deepEqual([...nonces], ['second', 'third'])
})

test('temporary previews are excluded from the private saved-follow snapshot', () => {
  const records = savedFollowRecords([
    {
      url: 'https://example.test/#one',
      localName: 'River',
      color: '#438ec9',
      saved: false,
      followedAt: 1_000,
    },
    {
      url: 'https://example.test/#two',
      localName: 'Forest',
      color: '#8a6fc9',
      saved: true,
      followedAt: 2_000,
    },
  ])
  assert.deepEqual(records, [
    { url: 'https://example.test/#two', localName: 'Forest', color: '#8a6fc9', followedAt: 2_000 },
  ])
})

test('generated names are stable for a share and do not expose its identifier', () => {
  const name = generatedFollowName('private-share-123')
  assert.equal(generatedFollowName('private-share-123'), name)
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
  assert.equal(name.includes('123'), false)
})

test('unavailable protected storage leaves temporary previews possible', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  try {
    for (const failure of ['load', 'save'] as const) {
      const source = createBrowserLocationSource({ sourceId: 'synthetic', geolocation: undefined })
      const runtime = createSharingRuntime(source, 'https://example.test/', {
        load: async () => {
          if (failure === 'load') throw new Error('Synthetic keyring unavailable.')
          return undefined
        },
        save: async () => {
          if (failure === 'save') throw new Error('Synthetic keyring unavailable.')
        },
      })
      try {
        await runtime.initialize()
        let message = ''
        runtime.subscribe((state) => {
          message = state.message
        })()
        assert.match(message, /preview only/i)
      } finally {
        await runtime.stop()
      }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('classifies follow freshness and terminal states explicitly', () => {
  const observation = { capturedAt: 10_000, expiresAt: 40_000 }
  assert.equal(followStatusFor({ connected: true, observation, now: 20_000 }), 'live')
  assert.equal(followStatusFor({ connected: true, observation, now: 30_000 }), 'delayed')
  assert.equal(followStatusFor({ connected: true, observation, now: 40_000 }), 'stale')
  assert.equal(followStatusFor({ connected: false, observation, now: 20_000 }), 'unavailable')
  assert.equal(
    followStatusFor({ connected: false, observation, now: 20_000, terminal: 'expired' }),
    'expired',
  )
  assert.equal(
    followStatusFor({ connected: false, observation, now: 20_000, terminal: 'revoked' }),
    'revoked',
  )
})

test('classifies heartbeat and expiry cleanup deterministically', () => {
  assert.equal(sessionSweepReason(null, 10_000, 20_000), undefined)
  assert.equal(sessionSweepReason(null, 10_000, 45_001), 'heartbeat-timeout')
  assert.equal(sessionSweepReason(30_000, 29_000, 30_000), 'expired')
  assert.equal(sessionSweepReason(30_000, 0, 70_000), 'expired')
})

test('failed group approval keeps the offer and permits a persisted retry', async () => {
  const source = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
  })
  const returned = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-return-peer',
    addresses: [],
    expiresAt: null,
  })
  const offer = {
    shareId: source.capability.shareId,
    viewerFingerprint: 'synthetic-viewer',
    ownerPeerId: 'synthetic-owner',
    url: returned.url,
  }
  const initial = {
    version: 1 as const,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(await generateKeyPair('Ed25519'))),
    shares: [
      {
        url: source.url,
        precision: 'approximate' as const,
        capacity: 1,
        publication: 'foreground' as const,
      },
    ],
    followed: [],
    returnOffers: [offer],
    oldSeeing: [
      { shareId: returned.capability.shareId, reason: 'revoked' as const, endedAt: Date.now() },
    ],
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  let fail = true
  let saved = initial as PrivateState
  const runtime = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => initial,
      save: async (value) => {
        if (fail) throw new Error('Synthetic private storage failure')
        saved = value
      },
    },
  )
  try {
    await assert.rejects(runtime.approveReturnLink(source.capability.shareId), /storage failure/)
    let state!: SharingRuntimeState
    const unsubscribe = runtime.subscribe((value) => {
      state = value
    })
    assert.deepEqual(state.approvedReturnLinks, [])
    assert.deepEqual(state.returnOffers, [offer])
    fail = false
    await runtime.approveReturnLink(source.capability.shareId)
    assert.deepEqual(saved.approvedReturnLinks, [source.capability.shareId])
    assert.deepEqual(saved.returnOffers, [offer])
    assert.deepEqual(state.returnOffers, [offer])
    fail = true
    await assert.rejects(runtime.stopShare(source.capability.shareId), /storage failure/)
    fail = false
    await runtime.approveReturnLink(source.capability.shareId)
    assert.equal(state.shares.length, 1)
    assert.deepEqual(state.endNotifications, [])
    assert.equal(saved.endedShares?.length, 0)
    await runtime.stopShare(source.capability.shareId)
    assert.equal(state.shares.length, 0)
    assert.equal(state.endNotifications.length, 1)
    assert.equal(saved.endedShares?.[0]?.reason, 'revoked')
    assert.deepEqual(Object.keys(saved.endedShares?.[0] ?? {}).sort(), [
      'endedAt',
      'publication',
      'reason',
      'url',
    ])
    await runtime.stopEndNotifications()
    assert.deepEqual(saved.endedShares, [])
    assert.equal(saved.oldSharing?.[0]?.reason, 'revoked')
    unsubscribe()
  } finally {
    await runtime.stop()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
