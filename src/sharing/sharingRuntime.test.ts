import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { bytesToBase64Url } from './encoding.ts'
import { createShareInvitation, returnOwnerMessage } from './shareLink.ts'
import type { PrivateState } from './privateStore.ts'

import { createBrowserLocationSource } from '../location/browser.ts'
import {
  acceptReturnShare,
  appendSessionEvent,
  claimSingleRecipient,
  followStatusFor,
  createSharingRuntime,
  generatedFollowName,
  rememberRedeemedNonce,
  savedFollowRecords,
  sessionSweepReason,
  type SharingRuntimeState,
} from './sharingRuntime.ts'

test('a concurrent first-device claim grants nothing before durable persistence', async () => {
  const share: { approvedPeerId?: string; claimPending?: boolean } = {}
  let release!: () => void
  let saves = 0
  const saving = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = claimSingleRecipient(share, 'peer-A', async () => {
    saves++
    await saving
  })
  assert.equal(share.claimPending, true)
  assert.equal(
    await claimSingleRecipient(share, 'peer-A', async () => {
      saves++
    }),
    'pending',
  )
  assert.equal(
    await claimSingleRecipient(share, 'peer-B', async () => {
      saves++
    }),
    'denied',
  )
  assert.equal(saves, 1)
  release()
  assert.equal(await first, 'claimed')
  assert.equal(
    await claimSingleRecipient(share, 'peer-A', async () => {
      saves++
    }),
    'claimed',
  )
  assert.equal(saves, 1)
})

test('storage failure rolls back the first-device claim', async () => {
  const share: { approvedPeerId?: string; claimPending?: boolean } = {}
  await assert.rejects(
    claimSingleRecipient(share, 'peer-A', async () => {
      throw new Error('storage failed')
    }),
    /storage failed/,
  )
  assert.equal(share.approvedPeerId, undefined)
  assert.equal(share.claimPending, false)
  assert.equal(await claimSingleRecipient(share, 'peer-B', async () => undefined), 'claimed')
})

test('retrying a received return after acknowledgement failure preserves its single viewer', async () => {
  const returned = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-return-peer',
    addresses: [],
    expiresAt: null,
  })
  const offer = {
    shareId: 'synthetic-original-share',
    viewerFingerprint: 'synthetic-viewer',
    ownerPeerId: 'synthetic-owner',
    url: returned.url,
  }
  let connected = false
  let joins = 0
  const receiver = {
    acceptShare: async (url: string, options?: { saved?: boolean; returnOwnerPeerId?: string }) => {
      assert.equal(url === returned.url, true)
      assert.equal(options?.saved, true)
      assert.equal(options?.returnOwnerPeerId === offer.ownerPeerId, true)
      connected = true
      joins += 1
    },
  }
  await acceptReturnShare(receiver, offer, () => connected)
  await acceptReturnShare(receiver, offer, () => connected)
  assert.equal(joins, 1)
})

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

test('shows approval pending before location and distinguishes a denied peer', () => {
  assert.equal(followStatusFor({ connected: false, approvalPending: true }), 'approval-pending')
  assert.equal(followStatusFor({ connected: false, approvalDenied: true }), 'denied')
})

test('classifies heartbeat and expiry cleanup deterministically', () => {
  assert.equal(sessionSweepReason(null, 10_000, 20_000), undefined)
  assert.equal(sessionSweepReason(null, 10_000, 45_001), 'heartbeat-timeout')
  assert.equal(sessionSweepReason(30_000, 29_000, 30_000), 'expired')
  assert.equal(sessionSweepReason(30_000, 0, 70_000), 'expired')
})

test('failed link-group approval keeps the offer and permits a persisted retry', async () => {
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
      'capacity',
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

test('an external return receiver preserves saved follows without restoring viewer sessions', async () => {
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-return-peer',
    addresses: [],
    expiresAt: null,
  })
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(await generateKeyPair('Ed25519'))),
    shares: [],
    followed: [
      {
        url: invitation.url,
        localName: 'Synthetic returned location',
        color: '#438ec9',
        followedAt: 1_000,
      },
    ],
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  let saved = initial
  const runtime = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => initial,
      save: async (value) => {
        saved = value
      },
    },
    'external',
  )
  const acceptShare = runtime.acceptShare
  let joins = 0
  runtime.acceptShare = async () => {
    joins += 1
  }
  try {
    await runtime.initialize()
    assert.equal(joins, 0)
    assert.deepEqual(saved.followed, initial.followed)
    await assert.rejects(acceptShare('invalid invitation'), /foreground receiver/)
  } finally {
    await runtime.stop()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('device comparison confirmation is explicit, durable, rollback-safe and bound to the admitted identity', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-source',
    addresses: [],
    expiresAt: null,
  })
  const comparison = {
    shareId: invitation.capability.shareId,
    ownPeerId: 'synthetic-source',
    peerId: 'synthetic-viewer',
    role: 'sender' as const,
    challenge: 'A'.repeat(43),
    letters: 'ABCD',
    expiresAt: Date.now() + 120000,
  }
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(await generateKeyPair('Ed25519'))),
    shares: [
      {
        url: invitation.url,
        precision: 'approximate',
        capacity: 1,
        approvedPeerId: comparison.peerId,
        publication: 'foreground',
      },
    ],
    followed: [],
    deviceComparisons: [comparison],
  }
  let saved = structuredClone(initial),
    fail = false
  const runtime = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => initial,
      save: async (state) => {
        if (fail) throw new Error('Synthetic storage failure')
        saved = structuredClone(state)
      },
    },
  )
  let state!: SharingRuntimeState
  runtime.subscribe((value) => {
    state = value
  })
  try {
    await runtime.approveReturnLink(comparison.shareId)
    assert.equal(state.deviceComparisons?.[0]?.confirmedAt, undefined)
    assert.deepEqual(saved.deviceComparisons, [])
    fail = true
    await assert.rejects(
      runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge),
      /storage failure/,
    )
    assert.equal(state.deviceComparisons?.[0]?.confirmedAt, undefined)
    fail = false
    await runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge)
    assert.ok(state.deviceComparisons?.[0]?.confirmedAt)
    await runtime.cancelDeviceComparison(comparison.shareId, comparison.challenge)
    assert.deepEqual(saved.deviceComparisons, [])
    await assert.rejects(
      runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge),
      /expired or cancelled/,
    )
    for (const changed of [
      { ...comparison, peerId: 'different-viewer' },
      { ...comparison, ownPeerId: 'different-source' },
      { ...comparison, expiresAt: Date.now() - 1 },
    ]) {
      const other = createSharingRuntime(
        createBrowserLocationSource({ sourceId: 'synthetic', geolocation: undefined }),
        'https://example.test/',
        {
          load: async () => ({ ...initial, deviceComparisons: [changed] }),
          save: async () => undefined,
        },
      )
      try {
        await assert.rejects(
          other.confirmDeviceComparison(comparison.shareId, comparison.challenge),
          /expired or cancelled/,
        )
      } finally {
        await other.stop()
      }
    }
  } finally {
    await runtime.stop()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('Android background return share accepts the foreground owner proof without sharing its private identity', async () => {
  const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
  const { parseShareInvitation, verifyReturnOwner } = await import('./shareLink.ts')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  const nativeIdentity = await generateKeyPair('Ed25519')
  const nativeShareKey = await generateKeyPair('Ed25519')
  const viewerIdentity = await generateKeyPair('Ed25519')
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: peerIdFromPrivateKey(nativeShareKey).toString(),
    addresses: [],
    expiresAt: null,
    ownerPrivateKey: nativeIdentity,
  })
  const nativeInitial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(nativeIdentity)),
    shares: [
      {
        url: invitation.url,
        sourcePrivateKey: bytesToBase64Url(privateKeyToProtobuf(nativeShareKey)),
        publication: 'background',
        precision: 'approximate',
        capacity: 1,
      },
    ],
    followed: [],
  }
  let saves = 0
  let saved = structuredClone(nativeInitial)
  const background = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'native', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => saved,
      save: async (state) => {
        saves += 1
        saved = structuredClone(state)
      },
    },
  )
  const foreground = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'foreground', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => ({
        version: 1,
        privateKey: bytesToBase64Url(privateKeyToProtobuf(viewerIdentity)),
        shares: [],
        followed: [],
      }),
      save: async () => undefined,
    },
  )
  try {
    const signed = await foreground.signReturnOwnership(
      invitation.capability.shareId,
      invitation.capability.sourcePeerId,
    )
    assert.equal(signed.ownerPeerId, peerIdFromPrivateKey(viewerIdentity).toString())
    assert.equal(signed.ownerPeerId === invitation.capability.ownerPeerId, false)
    await assert.rejects(
      background.replaceBackgroundShareOwner(
        invitation.capability.shareId,
        invitation.capability.sourcePeerId,
        signed.ownerPeerId,
        invitation.capability.ownerProof!,
        { mode: 'recipient', recipientPeerId: peerIdFromPrivateKey(nativeIdentity).toString() },
      ),
      /Invalid return ownership proof/,
    )
    const updated = await background.replaceBackgroundShareOwner(
      invitation.capability.shareId,
      invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      signed.ownerProof,
      { mode: 'recipient', recipientPeerId: peerIdFromPrivateKey(nativeIdentity).toString() },
    )
    const capability = parseShareInvitation(updated.url)
    assert.equal(capability.sourcePeerId, invitation.capability.sourcePeerId)
    assert.equal(capability.secret, invitation.capability.secret)
    assert.equal(capability.ownerPeerId, signed.ownerPeerId)
    assert.equal(await verifyReturnOwner(capability, signed.ownerPeerId), true)
    assert.equal(saved.privateKey, nativeInitial.privateKey)
    assert.equal(saved.shares[0]?.sourcePrivateKey, nativeInitial.shares[0]?.sourcePrivateKey)
    assert.equal(saved.shares[0]?.approvedPeerId, peerIdFromPrivateKey(nativeIdentity).toString())
    assert.equal(saved.shares[0]?.url, updated.url)
    const savedAfterHandoff = saves
    // Native command acknowledgement may be lost after the proof was saved.
    const again = await background.replaceBackgroundShareOwner(
      invitation.capability.shareId,
      invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      signed.ownerProof,
      { mode: 'recipient', recipientPeerId: peerIdFromPrivateKey(nativeIdentity).toString() },
    )
    assert.equal(again.url, updated.url)
    assert.equal(saves, savedAfterHandoff)
    await assert.rejects(
      background.replaceBackgroundShareOwner(
        invitation.capability.shareId,
        invitation.capability.sourcePeerId,
        signed.ownerPeerId,
        signed.ownerProof,
        { mode: 'recipient', recipientPeerId: 'synthetic-different-recipient' },
      ),
      /not available/,
    )
  } finally {
    await foreground.stop()
    await background.stop()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('Android background source share adopts the foreground owner proof for return targeting', async () => {
  const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
  const { parseShareInvitation, verifyReturnOwner } = await import('./shareLink.ts')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  const nativeIdentity = await generateKeyPair('Ed25519')
  const nativeShareKey = await generateKeyPair('Ed25519')
  const foregroundIdentity = await generateKeyPair('Ed25519')
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: peerIdFromPrivateKey(nativeShareKey).toString(),
    addresses: [],
    expiresAt: null,
    ownerPrivateKey: nativeIdentity,
  })
  const nativeInitial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(nativeIdentity)),
    shares: [
      {
        url: invitation.url,
        sourcePrivateKey: bytesToBase64Url(privateKeyToProtobuf(nativeShareKey)),
        publication: 'background',
        precision: 'approximate',
        capacity: 10,
      },
    ],
    followed: [],
  }
  let saves = 0
  let saved = structuredClone(nativeInitial)
  const background = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'native', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => saved,
      save: async (state) => {
        saves += 1
        saved = structuredClone(state)
      },
    },
  )
  const foreground = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'foreground', geolocation: undefined }),
    'https://example.test/',
    {
      load: async () => ({
        version: 1,
        privateKey: bytesToBase64Url(privateKeyToProtobuf(foregroundIdentity)),
        shares: [],
        followed: [],
      }),
      save: async () => undefined,
    },
  )
  try {
    const signed = await foreground.signReturnOwnership(
      invitation.capability.shareId,
      invitation.capability.sourcePeerId,
    )
    assert.equal(signed.ownerPeerId, peerIdFromPrivateKey(foregroundIdentity).toString())
    assert.equal(signed.ownerPeerId === invitation.capability.ownerPeerId, false)
    await assert.rejects(
      background.replaceBackgroundShareOwner(
        invitation.capability.shareId,
        invitation.capability.sourcePeerId,
        signed.ownerPeerId,
        invitation.capability.ownerProof!,
        { mode: 'source' },
      ),
      /Invalid return ownership proof/,
    )
    const updated = await background.replaceBackgroundShareOwner(
      invitation.capability.shareId,
      invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      signed.ownerProof,
      { mode: 'source' },
    )
    const capability = parseShareInvitation(updated.url)
    assert.equal(capability.sourcePeerId, invitation.capability.sourcePeerId)
    assert.equal(capability.secret, invitation.capability.secret)
    assert.equal(capability.ownerPeerId, signed.ownerPeerId)
    assert.equal(await verifyReturnOwner(capability, signed.ownerPeerId), true)
    assert.equal(saved.privateKey, nativeInitial.privateKey)
    assert.equal(saved.shares[0]?.sourcePrivateKey, nativeInitial.shares[0]?.sourcePrivateKey)
    assert.equal(saved.shares[0]?.approvedPeerId, undefined)
    assert.equal(saved.shares[0]?.url, updated.url)
    const savedAfterHandoff = saves
    const again = await background.replaceBackgroundShareOwner(
      invitation.capability.shareId,
      invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      signed.ownerProof,
      { mode: 'source' },
    )
    assert.equal(again.url, updated.url)
    assert.equal(saves, savedAfterHandoff)
    const other = await generateKeyPair('Ed25519')
    const otherOwnerPeerId = peerIdFromPrivateKey(other).toString()
    const otherOwnerProof = bytesToBase64Url(
      await other.sign(
        returnOwnerMessage(invitation.capability.shareId, invitation.capability.sourcePeerId),
      ),
    )
    await assert.rejects(
      background.replaceBackgroundShareOwner(
        invitation.capability.shareId,
        invitation.capability.sourcePeerId,
        otherOwnerPeerId,
        otherOwnerProof,
        { mode: 'source' },
      ),
      /already replaced/,
    )
  } finally {
    await foreground.stop()
    await background.stop()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
