import assert from 'node:assert/strict'
import test from 'node:test'

import type { ShareDraft } from '../shareDraft.ts'
import {
  createAndroidBackgroundSharing,
  type AndroidBackgroundStatus,
} from './backgroundSharing.ts'

const draft: ShareDraft = {
  precision: 'approximate',
  duration: '1h',
  viewerCapacity: 10,
  untilRevokedAcknowledged: false,
  name: 'River',
  publication: 'background',
  battery: 'saver',
  network: 'pause-when-metered',
}

const readyStatus: AndroidBackgroundStatus = {
  state: 'sharing',
  peerStatus: 'online',
  shares: [
    {
      shareId: 'share-1',
      url: 'https://constellation.taskyon.space/#share=test',
      precision: 'approximate',
      battery: 'saver',
      network: 'pause-when-metered',
      expiresAt: 3_600_000,
      viewerCount: 0,
    },
  ],
  location: { status: 'acquiring' },
  message: '',
}

test('browser controller is unavailable and never invokes Android', async () => {
  let invoked = false
  const controller = createAndroidBackgroundSharing({
    isAndroid: false,
    now: () => 0,
    invoke: async () => {
      invoked = true
      return readyStatus
    },
  })

  assert.equal(controller, undefined)
  assert.equal(invoked, false)
})

test('Android start request contains policy but no location', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  let permissionPrepared = false
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 1_000,
    preparePermissions: async () => {
      permissionPrepared = true
    },
    invoke: async (command, args) => {
      assert.equal(permissionPrepared, true)
      calls.push({ command, args })
      return readyStatus
    },
  })

  assert.deepEqual(
    await controller?.start(draft, 'https://constellation.taskyon.space/', true),
    readyStatus,
  )
  assert.deepEqual(calls, [
    {
      command: 'android_start_background_share',
      args: {
        request: {
          precision: 'approximate',
          viewerCapacity: 10,
          requireViewerApproval: true,
          name: 'River',
          publication: 'background',
          battery: 'saver',
          network: 'pause-when-metered',
          visible: true,
          expiresAt: 3_601_000,
          shareBaseUrl: 'https://constellation.taskyon.space/',
        },
      },
    },
  ])
  assert.equal(JSON.stringify(calls).includes('latitude'), false)
})

test('return owner handoff sends only the proof, never the foreground private key', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: Date.now,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return readyStatus
    },
  })
  await controller?.replaceBackgroundOwner(
    'synthetic-share',
    'synthetic-source',
    'synthetic-owner',
    'synthetic-proof',
    { mode: 'recipient', recipientPeerId: 'synthetic-recipient' },
  )
  assert.equal(calls[0]?.command, 'android_replace_background_owner')
  assert.deepEqual(JSON.parse(String(calls[0]?.args?.request)), {
    shareId: 'synthetic-share',
    sourcePeerId: 'synthetic-source',
    ownerPeerId: 'synthetic-owner',
    ownerProof: 'synthetic-proof',
    mode: 'recipient',
    recipientPeerId: 'synthetic-recipient',
  })
  await controller?.replaceBackgroundOwner(
    'synthetic-share',
    'synthetic-source',
    'synthetic-owner',
    'synthetic-proof',
    { mode: 'source' },
  )
  const sourceRequests = calls.filter((call) => call.command === 'android_replace_background_owner')
  assert.deepEqual(JSON.parse(String(sourceRequests[1]?.args?.request)), {
    shareId: 'synthetic-share',
    sourcePeerId: 'synthetic-source',
    ownerPeerId: 'synthetic-owner',
    ownerProof: 'synthetic-proof',
    mode: 'source',
  })
  assert.equal(JSON.stringify(calls).includes('privateKey'), false)
})

test('lost native acknowledgement is reconciled only against a verified signed return link', async () => {
  const { generateKeyPair } = await import('@libp2p/crypto/keys')
  const { createShareInvitation } = await import('../sharing/shareLink.ts')
  const owner = await generateKeyPair('Ed25519')
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-source',
    addresses: [],
    expiresAt: null,
    ownerPrivateKey: owner,
  })
  const signed = invitation.capability
  const status = {
    ...readyStatus,
    shares: [{ ...readyStatus.shares[0]!, shareId: signed.shareId, url: invitation.url }],
  }
  let polls = 0
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: Date.now,
    invoke: async (command) => {
      if (command === 'android_replace_background_owner') {
        throw new Error('native command timed out')
      }
      polls++
      return status
    },
  })
  const result = await controller?.replaceBackgroundOwner(
    signed.shareId,
    signed.sourcePeerId,
    signed.ownerPeerId!,
    signed.ownerProof!,
    { mode: 'recipient', recipientPeerId: 'synthetic-recipient' },
  )
  assert.deepEqual(result, status)
  assert.equal(polls, 1)

  const unchanged = createAndroidBackgroundSharing({
    isAndroid: true,
    now: Date.now,
    invoke: async (command) => {
      if (command === 'android_replace_background_owner') {
        throw new Error('native command timed out')
      }
      return readyStatus
    },
  })
  await assert.rejects(
    unchanged!.replaceBackgroundOwner(
      signed.shareId,
      signed.sourcePeerId,
      signed.ownerPeerId!,
      signed.ownerProof!,
      { mode: 'recipient', recipientPeerId: 'synthetic-recipient' },
    ),
    /native command timed out/,
  )
})

test('Android forwards the very coarse preset to its background service', async () => {
  let request: unknown
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 1_000,
    invoke: async (_command, args) => {
      request = args?.request
      return readyStatus
    },
  })

  await controller?.start({ ...draft, precision: 'very-coarse' }, 'https://example.test/', true)
  assert.equal((request as { precision?: string }).precision, 'very-coarse')
})

test('Android forwards a device block to its running background share', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return readyStatus
    },
  })

  assert.deepEqual(await controller?.blockViewer('share-1', 'device-a'), readyStatus)
  assert.deepEqual(calls, [
    {
      command: 'android_block_background_viewer',
      args: { shareId: 'share-1', fingerprint: 'device-a' },
    },
  ])
})

test('overlapping status polls share one native request and retry after completion', async () => {
  let requests = 0
  let complete: ((value: AndroidBackgroundStatus) => void) | undefined
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => {
      requests += 1
      return new Promise<AndroidBackgroundStatus>((resolve) => {
        complete = resolve
      })
    },
  })
  assert.ok(controller)

  const first = controller.status()
  const second = controller.status()
  assert.equal(requests, 1)
  complete?.(readyStatus)
  assert.deepEqual(await Promise.all([first, second]), [readyStatus, readyStatus])

  const third = controller.status()
  assert.equal(requests, 2)
  complete?.(readyStatus)
  assert.deepEqual(await third, readyStatus)
})

test('Android status rejects malformed native responses', async () => {
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ state: 'sharing', share: { url: 'secret' } }),
  })

  assert.ok(controller)
  await assert.rejects(controller.status(), /invalid background sharing status/i)
})

test('Android status rejects an unknown background peer state', async () => {
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, peerStatus: 'somewhere' }),
  })

  assert.ok(controller)
  await assert.rejects(controller.status(), /invalid background sharing status/i)
})

test('Android status carries the native policy pause and sampling state', async () => {
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, pauseReason: 'data-saver', sampling: 'saver' }),
  })

  assert.ok(controller)
  const status = await controller.status()
  assert.equal(status.pauseReason, 'data-saver')
  assert.equal(status.sampling, 'saver')
})

test('Android status rejects an unknown policy pause reason', async () => {
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, pauseReason: 'somewhere' }),
  })

  assert.ok(controller)
  await assert.rejects(controller.status(), /invalid background sharing status/i)
})

test('Android status carries an in-memory private return offer', async () => {
  const offer = {
    shareId: 'synthetic-share-id',
    viewerFingerprint: 'synthetic-device',
    ownerPeerId: 'synthetic-owner-peer',
    url: 'https://example.invalid/#share=synthetic-return-link',
  }
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, returnOffers: [offer] }),
  })

  assert.ok(controller)
  assert.deepEqual((await controller.status()).returnOffers, [offer])
})

test('Android status carries validated link-group return approval', async () => {
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({
      ...readyStatus,
      approvedReturnLinks: ['synthetic-share-id'],
    }),
  })
  assert.ok(controller)
  assert.deepEqual((await controller.status()).approvedReturnLinks, ['synthetic-share-id'])
  const malformed = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({
      ...readyStatus,
      approvedReturnLinks: [false],
    }),
  })
  assert.ok(malformed)
  await assert.rejects(malformed.status(), /invalid background sharing status/i)
})

test('Android status validates pending one-recipient approvals', async () => {
  const request = {
    shareId: 'synthetic-share-id',
    peerId: 'synthetic-peer-id',
    fingerprint: 'synthetic-device',
    requestedAt: 1_000,
  }
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, pendingViewerApprovals: [request] }),
  })
  assert.ok(controller)
  assert.deepEqual((await controller.status()).pendingViewerApprovals, [request])
  const malformed = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, pendingViewerApprovals: [{ ...request, peerId: 0 }] }),
  })
  assert.ok(malformed)
  await assert.rejects(malformed.status(), /invalid background sharing status/i)
})

test('Android status carries ended source links and rejects malformed return offers', async () => {
  const record = {
    shareId: 'synthetic-share-id',
    peerId: 'synthetic-authenticated-peer',
    endedAt: 1_000,
    reason: 'revoked' as const,
  }
  const legacyRecord = {
    shareId: 'synthetic-legacy-share-id',
    endedAt: 2_000,
    reason: 'expired' as const,
  }
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, oldSharing: [record, legacyRecord] }),
  })
  assert.ok(controller)
  assert.deepEqual((await controller.status()).oldSharing, [record, legacyRecord])

  const malformed = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, returnOffers: [{ shareId: 'missing-owner' }] }),
  })
  assert.ok(malformed)
  await assert.rejects(malformed.status(), /invalid background sharing status/i)
})

test('Android forwards link-group return approval to the sharing service', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return undefined
    },
  })

  assert.ok(controller)
  await controller.approveReturnLink('synthetic-share-id')
  assert.deepEqual(calls, [
    {
      command: 'android_approve_background_return_link',
      args: { shareId: 'synthetic-share-id' },
    },
  ])
})

test('Android forwards single-recipient peer approval to its sharing service', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return command === 'android_approve_background_viewer' ? {} : readyStatus
    },
  })

  assert.ok(controller)
  assert.deepEqual(
    await controller.approveViewer('synthetic-share-id', 'synthetic-peer-id'),
    readyStatus,
  )
  assert.deepEqual(calls, [
    {
      command: 'android_approve_background_viewer',
      args: { shareId: 'synthetic-share-id', peerId: 'synthetic-peer-id' },
    },
    { command: 'android_background_share_status', args: undefined },
  ])
})

test('Android persists name consent before polling the background status', async () => {
  const calls: string[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command) => {
      calls.push(command)
      return command === 'android_set_background_peer_names' ? {} : readyStatus
    },
  })
  assert.ok(controller)
  assert.deepEqual(
    await controller.setPeerNamePreferences('synthetic-peer', false, 'Alice'),
    readyStatus,
  )
  assert.deepEqual(calls, ['android_set_background_peer_names', 'android_background_share_status'])
})

test('Android forwards a dismissed return offer to the sharing service', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return undefined
    },
  })

  assert.ok(controller)
  await controller.dismissReturnOffer('synthetic-share-id', 'synthetic-device')
  assert.deepEqual(calls, [
    {
      command: 'android_dismiss_background_return_offer',
      args: { shareId: 'synthetic-share-id', fingerprint: 'synthetic-device' },
    },
  ])
})

test('Android comparison forwards only explicit confirmation/cancellation and validates status', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const comparison = {
    shareId: 'synthetic-share-0001',
    ownPeerId: 'synthetic-source',
    peerId: 'synthetic-viewer',
    role: 'sender' as const,
    challenge: 'A'.repeat(43),
    letters: 'ABCD',
    expiresAt: 123456,
  }
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 1000,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return { ...readyStatus, deviceComparisons: [comparison] }
    },
  })!
  for (const action of ['confirm', 'cancel'] as const) {
    assert.deepEqual(
      (await controller.deviceComparison(comparison.shareId, comparison.challenge, action))
        .deviceComparisons,
      [comparison],
    )
    assert.deepEqual(calls.at(-2), {
      command: 'android_background_device_comparison',
      args: {
        request: JSON.stringify({
          shareId: comparison.shareId,
          challenge: comparison.challenge,
          action,
        }),
      },
    })
  }
  const invalid = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 1000,
    invoke: async () => ({
      ...readyStatus,
      deviceComparisons: [{ ...comparison, letters: 'abcd' }],
    }),
  })!
  await assert.rejects(invalid.status(), /Invalid background sharing status/)
})

test('Android awaits durable advertised-name adoption before refreshing presence', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return command === 'android_adopt_background_peer_name' ? {} : readyStatus
    },
  })
  assert.ok(controller)
  assert.deepEqual(await controller.adoptPeerName('synthetic-peer', 'Forest'), readyStatus)
  assert.deepEqual(calls, [
    {
      command: 'android_adopt_background_peer_name',
      args: { peerId: 'synthetic-peer', name: 'Forest' },
    },
    { command: 'android_background_share_status', args: undefined },
  ])
})

test('Android clears old history with the shared active-peer protection and awaits persistence', async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const protection = { peerIds: ['synthetic-active-peer'], shareIds: ['synthetic-active-share'] }
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return command === 'android_clear_old_peers' ? {} : readyStatus
    },
  })
  assert.ok(controller)
  assert.deepEqual(await controller.clearOldPeers(protection), readyStatus)
  assert.deepEqual(calls, [
    { command: 'android_clear_old_peers', args: { protection } },
    { command: 'android_background_share_status', args: undefined },
  ])
})

test('global Android behavior waits for native acknowledgement before reading status', async () => {
  const calls: string[] = []
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 1,
    invoke: async (command) => {
      calls.push(command)
      return command === 'android_background_share_status' ? readyStatus : {}
    },
  })!
  await controller.setSharingBehavior({
    publication: 'foreground',
    battery: 'saver',
    network: 'always',
  })
  assert.deepEqual(calls, ['android_set_sharing_behavior', 'android_background_share_status'])
})
