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
}

const readyStatus: AndroidBackgroundStatus = {
  state: 'sharing',
  peerStatus: 'online',
  shares: [
    {
      shareId: 'share-1',
      url: 'https://constellation.taskyon.space/#share=test',
      precision: 'approximate',
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

test('Android status carries an in-memory private return offer', async () => {
  const offer = {
    shareId: 'synthetic-share-id',
    viewerFingerprint: 'synthetic-device',
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
