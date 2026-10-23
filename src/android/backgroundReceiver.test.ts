import assert from 'node:assert/strict'
import test from 'node:test'
import { createAndroidBackgroundReceiver } from './backgroundReceiver.ts'

test('receiver interface is Android-only and preserves native ownership generation', async () => {
  assert.equal(
    createAndroidBackgroundReceiver({ isAndroid: false, invoke: async () => undefined }),
    undefined,
  )
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const receiver = createAndroidBackgroundReceiver({
    isAndroid: true,
    invoke: async (command, args) => {
      calls.push({ command, args })
      return command === 'android_receiver_ownership'
        ? { owner: 'service', generation: 18, status: null }
        : null
    },
  })!
  assert.deepEqual(await receiver.ownership(), { owner: 'service', generation: 18, status: null })
  await receiver.stop(18)
  assert.deepEqual(calls[1], {
    command: 'android_stop_background_receiver',
    args: { generation: 18 },
  })
})

test('receiver status accepts validated observations and rejects stale generations', async () => {
  const observation = {
    profile: 'dev.constellation.location/v1',
    sourceId: 'peer-1',
    precision: 'approximate',
    sequence: 2,
    capturedAt: 1000,
    expiresAt: 9000,
    latitude: 33.1,
    longitude: -117.2,
    accuracyMeters: 100,
  }
  const status = {
    generation: 4,
    following: [{ shareId: 'share-1', status: 'live', connected: true, updatesReceived: 2 }],
    received: [{ shareId: 'share-1', state: 'live', observation }],
  }
  const native = (generation: number, payload: unknown) =>
    createAndroidBackgroundReceiver({
      isAndroid: true,
      invoke: async () => ({ owner: 'service', generation, status: payload }),
    })!
  const result = await native(4, status).ownership()
  assert.equal(result.status?.received[0]?.observation.latitude, 33.1)
  await assert.rejects(native(5, status).ownership(), /Stale receiver status/)
  await assert.rejects(
    native(4, {
      ...status,
      received: [
        { shareId: 'share-1', state: 'live', observation: { ...observation, latitude: 'invalid' } },
      ],
    }).ownership(),
    /latitude/,
  )
})
