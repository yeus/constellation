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
}

const readyStatus: AndroidBackgroundStatus = {
  state: 'sharing',
  share: {
    shareId: 'share-1',
    url: 'https://constellation.taskyon.space/#share=test',
    precision: 'approximate',
    expiresAt: 3_600_000,
    viewerCount: 0,
  },
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
    await controller?.start(draft, 'https://constellation.taskyon.space/'),
    readyStatus,
  )
  assert.deepEqual(calls, [
    {
      command: 'android_start_background_share',
      args: {
        request: {
          precision: 'approximate',
          viewerCapacity: 10,
          expiresAt: 3_601_000,
          shareBaseUrl: 'https://constellation.taskyon.space/',
        },
      },
    },
  ])
  assert.equal(JSON.stringify(calls).includes('latitude'), false)
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
