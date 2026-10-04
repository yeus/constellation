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

test('Android status carries ended source links and rejects malformed return offers', async () => {
  const record = {
    shareId: 'synthetic-share-id',
    endedAt: 1_000,
    reason: 'revoked' as const,
  }
  const controller = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, oldSharing: [record] }),
  })
  assert.ok(controller)
  assert.deepEqual((await controller.status()).oldSharing, [record])

  const malformed = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => ({ ...readyStatus, returnOffers: [{ shareId: 'missing-owner' }] }),
  })
  assert.ok(malformed)
  await assert.rejects(malformed.status(), /invalid background sharing status/i)
})

test('Android forwards return-link approval to the sharing service', async () => {
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
