import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { bytesToBase64Url } from './encoding.ts'
import { createShareInvitation, returnOwnerMessage } from './shareLink.ts'
import type { PrivateState } from './privateStore.ts'

import { createBrowserLocationSource, type BrowserPosition } from '../location/browser.ts'
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
  type SharingRuntime,
  type SharingRuntimeState,
} from './sharingRuntime.ts'

import { admitAuthenticatedSession } from './sharingRuntimeHelpers.ts'
const testInvitation = (
  sourcePeerId: string,
  overrides: Partial<Parameters<typeof createShareInvitation>[0]> = {},
) =>
  createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId,
    addresses: [],
    expiresAt: null,
    ...overrides,
  })

const testPrivateKey = async () =>
  bytesToBase64Url(privateKeyToProtobuf(await generateKeyPair('Ed25519')))

const installSyntheticWindow = () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  return () => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

const createTestRuntime = (
  initial: PrivateState,
  options: {
    receiver?: 'local' | 'external'
    save?: (state: PrivateState) => Promise<void>
    sourceId?: string
  } = {},
) =>
  createSharingRuntime(
    createBrowserLocationSource({
      sourceId: options.sourceId ?? 'synthetic',
      geolocation: undefined,
    }),
    'https://example.test/',
    { load: async () => initial, save: options.save ?? (async () => undefined) },
    options.receiver,
  )

const createMutableTestRuntime = (
  initial: PrivateState,
  options: { receiver?: 'local' | 'external'; sourceId?: string } = {},
) => {
  const saved: PrivateState = { ...initial }
  let fail = false
  const runtime = createTestRuntime(initial, {
    ...options,
    save: async (value) => {
      if (fail) throw new Error('Synthetic private storage failure')
      Object.assign(saved, value)
    },
  })
  return {
    runtime,
    saved,
    setFail: (next: boolean) => {
      fail = next
    },
  }
}

test('authenticated peer reconnect replaces its stale session without stealing capacity', () => {
  const stale = { peerId: 'peer-A', sessionId: 'old' }
  const sessions = new Set([stale])

  const intruder = { peerId: 'peer-B', sessionId: 'intruder' }
  assert.deepEqual(admitAuthenticatedSession(sessions, intruder, 1), {
    accepted: false,
    replaced: [],
  })
  assert.deepEqual([...sessions], [stale])

  const reconnect = { peerId: 'peer-A', sessionId: 'new' }
  assert.deepEqual(admitAuthenticatedSession(sessions, reconnect, 1), {
    accepted: true,
    replaced: [stale],
  })
  assert.deepEqual([...sessions], [reconnect])
  sessions.delete(stale) // Late old-stream cleanup must not remove the new session.
  assert.deepEqual([...sessions], [reconnect])

  const another = { peerId: 'peer-B', sessionId: 'other' }
  assert.equal(admitAuthenticatedSession(sessions, another, 1).accepted, false)
})

test('authenticated reconnect deduplicates sessions for the same peer at higher capacity', () => {
  const first = { peerId: 'peer-A', sessionId: 'a1' }
  const second = { peerId: 'peer-A', sessionId: 'a2' }
  const different = { peerId: 'peer-B', sessionId: 'b' }
  const sessions = new Set([first, second, different])
  const replacement = { peerId: 'peer-A', sessionId: 'a3' }

  assert.deepEqual(admitAuthenticatedSession(sessions, replacement, 3), {
    accepted: true,
    replaced: [first, second],
  })
  assert.deepEqual([...sessions], [different, replacement])
})

test('re-redeeming an existing authenticated transport never replaces itself', () => {
  const active = { peerId: 'peer-A', sessionId: 'original' }
  const sessions = new Set([active])
  assert.deepEqual(admitAuthenticatedSession(sessions, active, 1), {
    accepted: true,
    replaced: [],
  })
  assert.deepEqual([...sessions], [active])
})

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
  const returned = await testInvitation('synthetic-return-peer')
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
      sourceName: 'Link label',
      color: '#8a6fc9',
      saved: true,
      followedAt: 2_000,
    },
  ])
  assert.deepEqual(records, [
    {
      url: 'https://example.test/#two',
      localName: 'Forest',
      sourceName: 'Link label',
      color: '#8a6fc9',
      followedAt: 2_000,
    },
  ])
})

test('generated names are stable for a share and do not expose its identifier', () => {
  const name = generatedFollowName('private-share-123')
  assert.equal(generatedFollowName('private-share-123'), name)
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
  assert.equal(name.includes('123'), false)
})

test('unavailable protected storage leaves temporary previews possible', async () => {
  const restoreWindow = installSyntheticWindow()
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
    restoreWindow()
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

const createApprovalRetryFixture = async () => {
  const source = await testInvitation('synthetic-source-peer')
  const returned = await testInvitation('synthetic-return-peer')
  const offer = {
    shareId: source.capability.shareId,
    viewerFingerprint: 'synthetic-viewer',
    ownerPeerId: 'synthetic-owner',
    url: returned.url,
  }
  const initial: PrivateState = {
    version: 1,
    privateKey: await testPrivateKey(),
    shares: [
      {
        url: source.url,
        precision: 'approximate',
        capacity: 1,
        publication: 'foreground',
      },
    ],
    followed: [],
    returnOffers: [offer],
    oldSeeing: [{ shareId: returned.capability.shareId, reason: 'revoked', endedAt: Date.now() }],
  }
  const { runtime, saved, setFail } = createMutableTestRuntime(initial)
  let state!: SharingRuntimeState
  runtime.subscribe((value) => {
    state = value
  })
  return { runtime, saved, setFail, source, offer, state: () => state }
}

test('failed link-group approval keeps the offer and permits a persisted retry', async () => {
  const restoreWindow = installSyntheticWindow()
  const { runtime, saved, setFail, source, offer, state } = await createApprovalRetryFixture()
  setFail(true)
  try {
    await assert.rejects(runtime.approveReturnLink(source.capability.shareId), /storage failure/)
    assert.deepEqual(state().approvedReturnLinks, [])
    assert.deepEqual(state().returnOffers, [offer])
    setFail(false)
    await runtime.approveReturnLink(source.capability.shareId)
    assert.deepEqual(saved.approvedReturnLinks, [source.capability.shareId])
    assert.deepEqual(saved.returnOffers, [offer])
    assert.deepEqual(state().returnOffers, [offer])
    setFail(true)
    await assert.rejects(runtime.stopShare(source.capability.shareId), /storage failure/)
    setFail(false)
    await runtime.approveReturnLink(source.capability.shareId)
    assert.equal(state().shares.length, 1)
    assert.deepEqual(state().endNotifications, [])
    assert.equal(saved.endedShares?.length, 0)
    await runtime.stopShare(source.capability.shareId)
    assert.equal(state().shares.length, 0)
    assert.equal(state().endNotifications.length, 1)
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
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

test('an external return receiver preserves saved follows without restoring viewer sessions', async () => {
  const invitation = await testInvitation('synthetic-return-peer')
  const initial: PrivateState = {
    version: 1,
    privateKey: await testPrivateKey(),
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
  const restoreWindow = installSyntheticWindow()
  let saved = initial
  const runtime = createTestRuntime(initial, {
    receiver: 'external',
    save: async (value) => {
      saved = value
    },
  })
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
    restoreWindow()
  }
})

test('suspending foreground following leaves saved permissions intact and blocks restoration', async () => {
  const invitation = await testInvitation('synthetic-sender')
  const initial: PrivateState = {
    version: 1,
    privateKey: await testPrivateKey(),
    shares: [],
    followed: [
      {
        url: invitation.url,
        localName: 'Saved synthetic follow',
        color: '#438ec9',
        followedAt: 1_000,
      },
    ],
  }
  const restoreWindow = installSyntheticWindow()
  const runtime = createTestRuntime(initial)
  let attempts = 0
  runtime.acceptShare = async () => {
    attempts++
  }
  try {
    await runtime.setFollowingSuspended(true)
    await runtime.initialize()
    assert.equal(attempts, 0)
    await runtime.setFollowingSuspended(false)
    assert.equal(attempts, 1)
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

test('native receiver shutdown waits for a confirmed encrypted-state write before releasing ownership', async () => {
  const restoreWindow = installSyntheticWindow()
  let release!: () => void
  let saved!: () => void
  const persistAllowed = new Promise<void>((resolve) => {
    release = resolve
  })
  const saveStarted = new Promise<void>((resolve) => {
    saved = resolve
  })
  const runtime = createTestRuntime(
    {
      version: 1,
      privateKey: await testPrivateKey(),
      shares: [],
      followed: [],
    },
    {
      save: async () => {
        saved()
        await persistAllowed
      },
    },
  )
  try {
    await runtime.initialize()
    let finished = false
    const shutdown = runtime.stop({ requireDurableState: true }).then(() => {
      finished = true
    })
    await saveStarted
    assert.equal(finished, false)
    release()
    await shutdown
    assert.equal(finished, true)
  } finally {
    release?.()
    restoreWindow()
  }
})

test('native ownership is not released after a failed durable shutdown save', async () => {
  const restoreWindow = installSyntheticWindow()
  const runtime = createTestRuntime(
    {
      version: 1,
      privateKey: await testPrivateKey(),
      shares: [],
      followed: [],
    },
    {
      save: async () => {
        throw new Error('Durable state unavailable')
      },
    },
  )
  try {
    await runtime.initialize()
    await assert.rejects(runtime.stop({ requireDurableState: true }), /Durable state unavailable/)
  } finally {
    restoreWindow()
  }
})

test('startup never redials a saved follow previously denied by the sharer', async () => {
  const invitation = await testInvitation('denied-sender')
  const initial: PrivateState = {
    version: 1,
    privateKey: await testPrivateKey(),
    shares: [],
    followed: [
      {
        url: invitation.url,
        localName: 'Denied follow',
        color: '#438ec9',
        approvalDenied: true,
      },
    ],
  }
  const restoreWindow = installSyntheticWindow()
  const runtime = createTestRuntime(initial)
  let attempts = 0
  runtime.acceptShare = async () => {
    attempts++
  }
  try {
    await runtime.initialize()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(attempts, 0)
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

const comparisonFixtureState = async () => {
  const invitation = await testInvitation('synthetic-source')
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
    privateKey: await testPrivateKey(),
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
  return { comparison, initial }
}

const createComparisonFixture = async () => {
  const { comparison, initial } = await comparisonFixtureState()
  let saved = structuredClone(initial)
  let fail = false
  const runtime = createTestRuntime(initial, {
    save: async (state) => {
      if (fail) throw new Error('Synthetic storage failure')
      saved = structuredClone(state)
    },
  })
  let state!: SharingRuntimeState
  runtime.subscribe((value) => {
    state = value
  })
  return {
    runtime,
    initial,
    comparison,
    saved: () => saved,
    state: () => state,
    setFail: (next: boolean) => {
      fail = next
    },
  }
}

const assertChangedComparisonRejected = async (
  initial: PrivateState,
  comparison: { shareId: string; challenge: string },
  changed: NonNullable<PrivateState['deviceComparisons']>[number],
) => {
  const other = createTestRuntime({ ...initial, deviceComparisons: [changed] })
  try {
    await assert.rejects(
      other.confirmDeviceComparison(comparison.shareId, comparison.challenge),
      /expired or cancelled/,
    )
  } finally {
    await other.stop()
  }
}

test('device comparison confirmation is explicit, durable, rollback-safe and bound to the admitted identity', async () => {
  const restoreWindow = installSyntheticWindow()
  const { runtime, initial, comparison, saved, state, setFail } = await createComparisonFixture()
  try {
    await runtime.approveReturnLink(comparison.shareId)
    assert.equal(state().deviceComparisons?.[0]?.confirmedAt, undefined)
    assert.deepEqual(saved().deviceComparisons, [])
    setFail(true)
    await assert.rejects(
      runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge),
      /storage failure/,
    )
    assert.equal(state().deviceComparisons?.[0]?.confirmedAt, undefined)
    setFail(false)
    await runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge)
    assert.ok(state().deviceComparisons?.[0]?.confirmedAt)
    await runtime.cancelDeviceComparison(comparison.shareId, comparison.challenge)
    assert.deepEqual(saved().deviceComparisons, [])
    await assert.rejects(
      runtime.confirmDeviceComparison(comparison.shareId, comparison.challenge),
      /expired or cancelled/,
    )
    for (const changed of [
      { ...comparison, peerId: 'different-viewer' },
      { ...comparison, ownPeerId: 'different-source' },
      { ...comparison, expiresAt: Date.now() - 1 },
    ]) {
      await assertChangedComparisonRejected(initial, comparison, changed)
    }
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

const ownerHandoffFixtureState = async (capacity: 1 | 10) => {
  const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
  const { parseShareInvitation, verifyReturnOwner } = await import('./shareLink.ts')
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
        capacity,
      },
    ],
    followed: [],
  }
  return {
    invitation,
    nativeIdentity,
    foregroundIdentity,
    nativeInitial,
    parseShareInvitation,
    verifyReturnOwner,
    peerIdFromPrivateKey,
  }
}

const createOwnerHandoffFixture = async (capacity: 1 | 10) => {
  const state = await ownerHandoffFixtureState(capacity)
  let saves = 0
  let saved = structuredClone(state.nativeInitial)
  const background = createTestRuntime(state.nativeInitial, {
    sourceId: 'native',
    save: async (next) => {
      saves += 1
      saved = structuredClone(next)
    },
  })
  const foreground = createTestRuntime(
    {
      version: 1,
      privateKey: bytesToBase64Url(privateKeyToProtobuf(state.foregroundIdentity)),
      shares: [],
      followed: [],
    },
    { sourceId: 'foreground' },
  )
  return {
    ...state,
    background,
    foreground,
    saved: () => saved,
    saves: () => saves,
  }
}

const signOwnerHandoff = async (f: Awaited<ReturnType<typeof createOwnerHandoffFixture>>) => {
  const signed = await f.foreground.signReturnOwnership(
    f.invitation.capability.shareId,
    f.invitation.capability.sourcePeerId,
  )
  assert.equal(signed.ownerPeerId, f.peerIdFromPrivateKey(f.foregroundIdentity).toString())
  assert.equal(signed.ownerPeerId === f.invitation.capability.ownerPeerId, false)
  return signed
}

const assertOwnerProofRejected = async (
  f: Awaited<ReturnType<typeof createOwnerHandoffFixture>>,
  signed: { ownerPeerId: string; ownerProof: string },
  binding: { mode: 'source' } | { mode: 'recipient'; recipientPeerId: string },
) =>
  assert.rejects(
    f.background.replaceBackgroundShareOwner(
      f.invitation.capability.shareId,
      f.invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      f.invitation.capability.ownerProof!,
      binding,
    ),
    /Invalid return ownership proof/,
  )

const assertOwnerHandoffStored = (
  f: Awaited<ReturnType<typeof createOwnerHandoffFixture>>,
  signed: { ownerPeerId: string; ownerProof: string },
  updated: { url: string },
  approvedPeerId: string | undefined,
) => {
  const capability = f.parseShareInvitation(updated.url)
  assert.equal(capability.sourcePeerId, f.invitation.capability.sourcePeerId)
  assert.equal(capability.secret, f.invitation.capability.secret)
  assert.equal(capability.ownerPeerId, signed.ownerPeerId)
  assert.equal(f.saved().privateKey, f.nativeInitial.privateKey)
  assert.equal(f.saved().shares[0]?.sourcePrivateKey, f.nativeInitial.shares[0]?.sourcePrivateKey)
  assert.equal(f.saved().shares[0]?.approvedPeerId, approvedPeerId)
  assert.equal(f.saved().shares[0]?.url, updated.url)
}

const assertOwnerHandoffIdempotent = async (
  f: Awaited<ReturnType<typeof createOwnerHandoffFixture>>,
  signed: { ownerPeerId: string; ownerProof: string },
  binding: { mode: 'source' } | { mode: 'recipient'; recipientPeerId: string },
  updated: { url: string },
) => {
  const saves = f.saves()
  const again = await f.background.replaceBackgroundShareOwner(
    f.invitation.capability.shareId,
    f.invitation.capability.sourcePeerId,
    signed.ownerPeerId,
    signed.ownerProof,
    binding,
  )
  assert.equal(again.url, updated.url)
  assert.equal(f.saves(), saves)
}

test('Android background return share accepts the foreground owner proof without sharing its private identity', async () => {
  const restoreWindow = installSyntheticWindow()
  const f = await createOwnerHandoffFixture(1)
  const recipientPeerId = f.peerIdFromPrivateKey(f.nativeIdentity).toString()
  const binding = { mode: 'recipient' as const, recipientPeerId }
  try {
    const signed = await signOwnerHandoff(f)
    await assertOwnerProofRejected(f, signed, binding)
    const updated = await f.background.replaceBackgroundShareOwner(
      f.invitation.capability.shareId,
      f.invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      signed.ownerProof,
      binding,
    )
    assertOwnerHandoffStored(f, signed, updated, recipientPeerId)
    await assertOwnerHandoffIdempotent(f, signed, binding, updated)
    await assert.rejects(
      f.background.replaceBackgroundShareOwner(
        f.invitation.capability.shareId,
        f.invitation.capability.sourcePeerId,
        signed.ownerPeerId,
        signed.ownerProof,
        { mode: 'recipient', recipientPeerId: 'synthetic-different-recipient' },
      ),
      /not available/,
    )
  } finally {
    await f.foreground.stop()
    await f.background.stop()
    restoreWindow()
  }
})

test('Android background source share adopts the foreground owner proof for return targeting', async () => {
  const restoreWindow = installSyntheticWindow()
  const f = await createOwnerHandoffFixture(10)
  try {
    const signed = await signOwnerHandoff(f)
    await assertOwnerProofRejected(f, signed, { mode: 'source' })
    const updated = await f.background.replaceBackgroundShareOwner(
      f.invitation.capability.shareId,
      f.invitation.capability.sourcePeerId,
      signed.ownerPeerId,
      signed.ownerProof,
      { mode: 'source' },
    )
    assertOwnerHandoffStored(f, signed, updated, undefined)
    await assertOwnerHandoffIdempotent(f, signed, { mode: 'source' }, updated)
    const other = await generateKeyPair('Ed25519')
    const otherOwnerPeerId = f.peerIdFromPrivateKey(other).toString()
    const otherOwnerProof = bytesToBase64Url(
      await other.sign(
        returnOwnerMessage(f.invitation.capability.shareId, f.invitation.capability.sourcePeerId),
      ),
    )
    await assert.rejects(
      f.background.replaceBackgroundShareOwner(
        f.invitation.capability.shareId,
        f.invitation.capability.sourcePeerId,
        otherOwnerPeerId,
        otherOwnerProof,
        { mode: 'source' },
      ),
      /already replaced/,
    )
  } finally {
    await f.foreground.stop()
    await f.background.stop()
    restoreWindow()
  }
})

test('advertised-name adoption is durable while disconnected and rolls back on storage failure', async () => {
  const key = await generateKeyPair('Ed25519')
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(key)),
    shares: [],
    followed: [],
    peerNamePreferences: [
      {
        peerId: 'synthetic-peer',
        associateNames: false,
        sharedName: null,
        receivedName: 'Forest',
        acceptedName: 'River',
      },
    ],
  }
  const restoreWindow = installSyntheticWindow()
  const { runtime, saved, setFail } = createMutableTestRuntime(initial)
  setFail(true)
  try {
    await assert.rejects(runtime.adoptPeerName('synthetic-peer', 'Forest'), /storage failure/)
    let state!: SharingRuntimeState
    runtime.subscribe((value) => {
      state = value
    })
    assert.equal(state.peerNamePreferences![0]!.acceptedName, 'River')
    await assert.rejects(runtime.adoptPeerName('synthetic-peer', 'Outdated name'), /changed/)
    setFail(false)
    await runtime.adoptPeerName('synthetic-peer', 'Forest')
    assert.equal(state.peerNamePreferences![0]!.acceptedName, 'Forest')
    assert.equal(saved.peerNamePreferences![0]!.acceptedName, 'Forest')
    assert.equal(saved.peerNamePreferences![0]!.sharedName, null)
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

const historyClearFixtureState = async () => {
  const key = await generateKeyPair('Ed25519')
  const ended = await testInvitation('synthetic-source')
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(key)),
    shares: [],
    followed: [],
    oldSharing: [
      {
        shareId: 'synthetic-ended-share',
        peerId: 'synthetic-old-peer',
        endedAt: 1,
        reason: 'revoked',
      },
    ],
    oldSeeing: [{ shareId: ended.capability.shareId, endedAt: 1, reason: 'expired' }],
    stoppedViewers: [
      {
        shareId: 'synthetic-stopped-share',
        peerId: 'synthetic-protected-peer',
        eventId: 'synthetic-stop-event',
        recordedAt: 1,
        dismissed: true,
      },
    ],
    pendingStopNotices: [
      {
        shareId: 'synthetic-pending-share',
        sourcePeerId: 'synthetic-source',
        viewerPeerId: 'synthetic-viewer',
        addresses: [],
        proof: 'A'.repeat(43),
        eventId: 'synthetic-pending-event',
        queuedAt: Date.now(),
      },
    ],
  }
  return { ended, initial }
}

const createHistoryClearFixture = async () => {
  const { ended, initial } = await historyClearFixtureState()
  const { runtime, saved, setFail } = createMutableTestRuntime(initial)
  let state!: SharingRuntimeState
  runtime.subscribe((value) => {
    state = value
  })
  return { runtime, saved, setFail, state: () => state, ended, initial }
}

const assertClearedHistory = (state: SharingRuntimeState, saved: PrivateState) => {
  assert.deepEqual(state.oldSharing, [])
  assert.deepEqual(state.oldSeeing, [])
  assert.equal(state.stoppedViewers.length, 1)
  assert.equal(saved.oldSharing![0]!.cleared, true)
  assert.equal(saved.oldSeeing![0]!.cleared, true)
}

test('clearing old peers hides history durably while retaining delivery ledgers and ended-link protections', async () => {
  const restoreWindow = installSyntheticWindow()
  const { runtime, saved, setFail, state, ended, initial } = await createHistoryClearFixture()
  setFail(true)
  try {
    await assert.rejects(
      runtime.clearOldPeers({ peerIds: ['synthetic-protected-peer'], shareIds: [] }),
      /storage failure/,
    )
    assert.equal(state().oldSharing.length, 1)
    setFail(false)
    await runtime.clearOldPeers({ peerIds: ['synthetic-protected-peer'], shareIds: [] })
    assertClearedHistory(state(), saved)
    assert.deepEqual(saved.pendingStopNotices, initial.pendingStopNotices)
    await assert.rejects(runtime.acceptShare(ended.url), /ended/)
    const restored = createTestRuntime(saved, { sourceId: 'synthetic-restored' })
    try {
      await restored.clearOldPeers({ peerIds: ['synthetic-protected-peer'], shareIds: [] })
      restored.subscribe((value) => assertClearedHistory(value, saved))
      await assert.rejects(restored.acceptShare(ended.url), /ended/)
    } finally {
      await restored.stop()
    }
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

const globalBehaviorState = async () => {
  const key = await generateKeyPair('Ed25519')
  const invitation = await testInvitation('synthetic-source')
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(key)),
    shares: [
      {
        url: invitation.url,
        precision: 'approximate',
        capacity: 1,
        publication: 'foreground',
        approvedPeerId: 'synthetic-recipient',
      },
    ],
    followed: [],
  }
  return { invitation, initial }
}

const createGlobalBehaviorFixture = async () => {
  const { invitation, initial } = await globalBehaviorState()
  let saved = initial
  let fail = false
  const makeRuntime = () =>
    createTestRuntime(saved, {
      save: async (value) => {
        if (fail) throw new Error('Synthetic storage failure')
        saved = value
      },
    })
  return {
    runtime: makeRuntime(),
    makeRuntime,
    saved: () => saved,
    setFail: (next: boolean) => {
      fail = next
    },
    invitation,
  }
}

const assertRestoredPolicy = async (
  makeRuntime: () => SharingRuntime,
  saved: () => PrivateState,
  invitation: { url: string },
  policy: { battery: 'saver'; publication: 'background'; network: 'pause-when-metered' },
) => {
  const restored = makeRuntime()
  try {
    await restored.setSharingBehavior({ ...policy, publication: 'foreground' })
    assert.equal(saved().shares[0]!.url, invitation.url)
    assert.equal(saved().shares[0]!.publication, 'foreground')
    assert.equal(saved().sharingBehavior!.battery, 'saver')
  } finally {
    await restored.stop()
  }
}

test('global behavior changes active links without replacing capabilities and survives restart with rollback', async () => {
  const restoreWindow = installSyntheticWindow()
  const { runtime, makeRuntime, saved, setFail, invitation } = await createGlobalBehaviorFixture()
  try {
    const policy = {
      publication: 'background' as const,
      battery: 'saver' as const,
      network: 'pause-when-metered' as const,
    }
    await runtime.setSharingBehavior(policy)
    assert.deepEqual(saved().sharingBehavior, policy)
    assert.equal(saved().shares[0]!.url, invitation.url)
    assert.equal(saved().shares[0]!.approvedPeerId, 'synthetic-recipient')
    assert.equal(saved().shares[0]!.publication, 'background')
    assert.equal(saved().shares[0]!.battery, 'saver')
    setFail(true)
    await assert.rejects(
      runtime.setSharingBehavior({ ...policy, publication: 'foreground' }),
      /storage failure/,
    )
    let latest!: SharingRuntimeState
    runtime.subscribe((state) => {
      latest = state
    })
    assert.deepEqual(latest.sharingBehavior, policy)
    assert.equal(latest.shares[0]!.publication, 'background')
    setFail(false)
    await assertRestoredPolicy(makeRuntime, saved, invitation, policy)
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

const sourceImportState = async () => {
  const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
  const nativeKey = await generateKeyPair('Ed25519')
  const viewerKey = await generateKeyPair('Ed25519')
  const sourceKey = await generateKeyPair('Ed25519')
  const nativeIdentity = bytesToBase64Url(privateKeyToProtobuf(nativeKey))
  const sourceIdentity = bytesToBase64Url(privateKeyToProtobuf(sourceKey))
  const viewerIdentity = bytesToBase64Url(privateKeyToProtobuf(viewerKey))
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: peerIdFromPrivateKey(sourceKey).toString(),
    addresses: [],
    expiresAt: null,
    ownerPrivateKey: viewerKey,
  })
  const incoming: PrivateState = {
    version: 1,
    privateKey: viewerIdentity,
    shares: [
      {
        url: invitation.url,
        sourcePrivateKey: sourceIdentity,
        precision: 'approximate',
        capacity: 1,
        publication: 'foreground',
        approvedPeerId: 'synthetic-recipient',
      },
    ],
    followed: [],
  }
  return { nativeIdentity, sourceIdentity, viewerIdentity, invitation, incoming }
}

const createSourceImportFixture = async () => {
  const state = await sourceImportState()
  const { runtime, saved, setFail } = createMutableTestRuntime(
    { version: 1, privateKey: state.nativeIdentity, shares: [], followed: [] },
    { sourceId: 'synthetic-import' },
  )
  return { ...state, runtime, saved, setFail }
}

test('source import merges independent source identities without replacing the native or viewer identity', async () => {
  const restoreWindow = installSyntheticWindow()
  const fixture = await createSourceImportFixture()
  fixture.setFail(true)
  try {
    await assert.rejects(fixture.runtime.importSourceShares(fixture.incoming), /storage failure/)
    fixture.setFail(false)
    await fixture.runtime.importSourceShares(fixture.incoming)
    await fixture.runtime.importSourceShares(fixture.incoming)
    assert.equal(fixture.saved.privateKey, fixture.nativeIdentity)
    assert.equal(fixture.incoming.privateKey, fixture.viewerIdentity)
    assert.equal(fixture.saved.shares.length, 1)
    assert.equal(fixture.saved.shares[0]!.sourcePrivateKey, fixture.sourceIdentity)
    assert.equal(fixture.saved.shares[0]!.url, fixture.invitation.url)
    assert.equal(fixture.saved.shares[0]!.approvedPeerId, 'synthetic-recipient')
  } finally {
    await fixture.runtime.stop()
    restoreWindow()
  }
})

const deferredSave = () => {
  let finishSave!: () => void
  let startedSave!: () => void
  const started = new Promise<void>((resolve) => {
    startedSave = resolve
  })
  return {
    started,
    start: () => startedSave(),
    wait: () =>
      new Promise<void>((resolve) => {
        finishSave = resolve
      }),
    finish: () => finishSave(),
  }
}

const policyInitialState = async () => {
  const key = await generateKeyPair('Ed25519')
  const invitation = await testInvitation('synthetic-source')
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(key)),
    shares: [
      {
        url: invitation.url,
        precision: 'approximate',
        capacity: 1,
        publication: 'foreground',
      },
    ],
    followed: [],
  }
  return initial
}

const createPolicyFixture = async () => {
  const initial = await policyInitialState()
  const gate = deferredSave()
  const runtime = createTestRuntime(initial, {
    sourceId: 'synthetic-policy',
    save: async () => {
      gate.start()
      await gate.wait()
    },
  })
  let state!: SharingRuntimeState
  runtime.subscribe((next) => {
    state = next
  })
  return { runtime, state: () => state, gate }
}

test('global policy is not published or applied until its durable save completes', async () => {
  const restoreWindow = installSyntheticWindow()
  const { runtime, state, gate } = await createPolicyFixture()
  try {
    const updating = runtime.setSharingBehavior({
      publication: 'background',
      battery: 'saver',
      network: 'always',
    })
    await gate.started
    assert.equal(state().sharingBehavior, undefined)
    assert.equal(state().shares[0]!.publication, 'foreground')
    gate.finish()
    await updating
    assert.equal(state().sharingBehavior!.publication, 'background')
    assert.equal(state().shares[0]!.publication, 'background')
  } finally {
    await runtime.stop()
    restoreWindow()
  }
})

const pausePosition = (latitude: number, timestamp: number): BrowserPosition => ({
  timestamp,
  coords: {
    latitude,
    longitude: -70,
    accuracy: 8,
    altitude: null,
    heading: null,
    speed: null,
  },
})

const pauseFixtureState = async () => {
  const key = await generateKeyPair('Ed25519')
  const invitation = await testInvitation('synthetic-source')
  const initial: PrivateState = {
    version: 1,
    privateKey: bytesToBase64Url(privateKeyToProtobuf(key)),
    shares: [
      {
        url: invitation.url,
        precision: 'approximate',
        capacity: 1,
        publication: 'foreground',
      },
    ],
    followed: [],
  }
  return { invitation, initial }
}

const createPauseLocationSource = (
  setDeliver: (deliver: (position: BrowserPosition) => void) => void,
) =>
  createBrowserLocationSource({
    sourceId: 'synthetic-pause',
    geolocation: {
      watchPosition: (success) => {
        setDeliver(success)
        return 7
      },
      clearWatch: () => undefined,
      getCurrentPosition: () => undefined,
    },
    now: () => 5_000,
    liveWindowMs: 5_000,
    observationTtlMs: 60_000,
    setTimer: () => 1,
    clearTimer: () => undefined,
  })

const createPauseFixture = async () => {
  const { invitation, initial } = await pauseFixtureState()
  let saved = structuredClone(initial)
  let fail = false
  let deliver: ((position: BrowserPosition) => void) | undefined
  const source = createPauseLocationSource((next) => {
    deliver = next
  })
  const runtime = createSharingRuntime(source, 'https://example.test/', {
    load: async () => saved,
    save: async (value) => {
      if (fail) throw new Error('Synthetic storage failure')
      saved = structuredClone(value)
    },
  })
  let state!: SharingRuntimeState
  runtime.subscribe((value) => {
    state = value
  })
  return {
    runtime,
    invitation,
    saved: () => saved,
    setFail: (next: boolean) => {
      fail = next
    },
    state: () => state,
    deliver: (position: BrowserPosition) => deliver?.(position),
    position: pausePosition,
  }
}

test('a user pause stops observations durably without revoking the grant and resumes on request', async () => {
  const restoreWindow = installSyntheticWindow()
  const f = await createPauseFixture()
  try {
    await f.runtime.setPaused(true)
    assert.equal(f.state().paused, true)
    assert.equal(f.state().shares[0]!.paused, 'user')
    assert.equal(f.saved().paused, true)
    assert.equal(f.saved().shares.length, 1)
    assert.equal(f.saved().endedShares?.length, 0)
    f.runtime.setVisible(true, true)
    f.deliver(f.position(40, 10_000))
    assert.equal(f.state().shares[0]!.lastUpdateAt, undefined)
    f.deliver(f.position(41, 15_000))
    assert.equal(f.state().shares[0]!.lastUpdateAt, undefined)
    f.setFail(true)
    await assert.rejects(f.runtime.setPaused(false), /storage failure/)
    assert.equal(f.state().paused, true)
    assert.equal(f.state().shares[0]!.paused, 'user')
    f.setFail(false)
    await f.runtime.setPaused(false)
    assert.equal(f.state().paused, false)
    assert.equal(f.state().shares[0]!.paused, undefined)
    assert.equal(f.saved().paused, undefined)
    assert.equal(f.saved().shares.length, 1)
    f.deliver(f.position(42, 20_000))
    assert.equal(f.state().shares[0]!.lastUpdateAt, 20_000)
    await f.runtime.setPaused(true)
    assert.equal(f.state().paused, true)
    await f.runtime.stopShare(f.invitation.capability.shareId)
    assert.equal(f.state().shares.length, 0)
    assert.equal(f.state().paused, false)
    assert.equal(f.saved().paused, undefined)
  } finally {
    await f.runtime.stop()
    restoreWindow()
  }
})
