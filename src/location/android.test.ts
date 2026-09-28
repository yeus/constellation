import assert from 'node:assert/strict'
import test from 'node:test'

import { createAndroidGeolocationAdapter } from './android.ts'

const position = {
  timestamp: 1_000,
  coords: {
    latitude: 40,
    longitude: -70,
    accuracy: 900,
    altitude: null,
    heading: null,
    speed: null,
  },
}

test('Android accepts a coarse-only grant and preserves its reported uncertainty', async () => {
  const calls: string[] = []
  const source = createAndroidGeolocationAdapter({
    permission: async () => ({ grant: 'coarse', servicesEnabled: true }),
    requestPermission: async () => {
      throw new Error('Permission was already granted.')
    },
    watch: async (_options, emit) => {
      calls.push('watch')
      emit({ position })
      return 9
    },
    clearWatch: async (id) => {
      calls.push(`stop:${id}`)
    },
    current: async () => position,
  })
  const received: number[] = []
  const id = await source.watchPosition((fix) => received.push(fix.coords.accuracy))
  await source.clearWatch(id)
  assert.deepEqual(received, [900])
  assert.deepEqual(calls, ['watch', 'stop:9'])
})

test('Android requests both permissions once and does not watch after denial', async () => {
  const calls: string[] = []
  const source = createAndroidGeolocationAdapter({
    permission: async () => ({ grant: 'none', servicesEnabled: true }),
    requestPermission: async () => {
      calls.push('request')
      return { grant: 'none', servicesEnabled: true }
    },
    watch: async () => {
      throw new Error('Must not start.')
    },
    clearWatch: async () => undefined,
    current: async () => position,
  })
  await assert.rejects(
    Promise.resolve(source.watchPosition(() => undefined)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 1,
  )
  assert.deepEqual(calls, ['request'])
})

test('Android reports disabled device location without attempting a webview bypass', async () => {
  const source = createAndroidGeolocationAdapter({
    permission: async () => ({ grant: 'fine', servicesEnabled: false }),
    requestPermission: async () => {
      throw new Error('Must not request.')
    },
    watch: async () => {
      throw new Error('Must not start.')
    },
    clearWatch: async () => undefined,
    current: async () => position,
  })
  await assert.rejects(
    Promise.resolve(source.watchPosition(() => undefined)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 4,
  )
})

test('permission revoked between check and registration remains a denial', async () => {
  let checks = 0
  const source = createAndroidGeolocationAdapter({
    permission: async () => ({ grant: ++checks === 1 ? 'fine' : 'none', servicesEnabled: true }),
    requestPermission: async () => ({ grant: 'none', servicesEnabled: true }),
    watch: async () => {
      throw new Error('Native permission changed.')
    },
    clearWatch: async () => undefined,
    current: async () => position,
  })
  await assert.rejects(
    Promise.resolve(source.watchPosition(() => undefined)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 1,
  )
})

test('rejected permission prompt cannot trigger a technical WebView fallback', async () => {
  const source = createAndroidGeolocationAdapter({
    permission: async () => ({ grant: 'none', servicesEnabled: true }),
    requestPermission: async () => {
      throw new Error('Permission rejected.')
    },
    watch: async () => {
      throw new Error('Must not start.')
    },
    clearWatch: async () => undefined,
    current: async () => position,
  })
  await assert.rejects(
    Promise.resolve(source.watchPosition(() => undefined)),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 1,
  )
})
