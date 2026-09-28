import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserLocationSource, type BrowserGeolocation } from './browser.ts'

const createFixture = () => {
  let success: Parameters<BrowserGeolocation['watchPosition']>[0] | undefined
  let failure: Parameters<BrowserGeolocation['watchPosition']>[1]
  const cleared: number[] = []
  const timers = new Map<number, () => void>()
  let receivedOptions: PositionOptions | undefined
  let refreshCount = 0
  let nextTimer = 1
  let now = 10_000

  const geolocation: BrowserGeolocation = {
    watchPosition: (onSuccess, onError, options) => {
      success = onSuccess
      failure = onError
      receivedOptions = options
      return 42
    },
    clearWatch: (id) => {
      cleared.push(id)
    },
    getCurrentPosition: () => {
      refreshCount += 1
    },
  }

  const source = createBrowserLocationSource({
    sourceId: 'synthetic-browser',
    geolocation,
    now: () => now,
    liveWindowMs: 5_000,
    observationTtlMs: 20_000,
    setTimer: (callback) => {
      const id = nextTimer++
      timers.set(id, callback)
      return id
    },
    clearTimer: (id) => timers.delete(id),
  })

  return {
    source,
    cleared,
    setNow: (value: number) => {
      now = value
    },
    succeed: (accuracy = 8) =>
      success?.({
        timestamp: 10_000,
        coords: {
          latitude: 40,
          longitude: -70,
          accuracy,
          altitude: null,
          heading: null,
          speed: null,
        },
      }),
    deny: () => failure?.({ code: 1 }),
    runTimers: () => [...timers.values()].forEach((callback) => callback()),
    getPositionOptions: () => receivedOptions,
    getRefreshCount: () => refreshCount,
  }
}

test('owns geolocation start and stop with monotonic observations', () => {
  const fixture = createFixture()
  const observations: number[] = []
  fixture.source.subscribeObservation((observation) => {
    observations.push(observation.sequence)
  })

  assert.equal(fixture.source.getState().status, 'permission-required')
  fixture.source.start()
  assert.equal(fixture.source.getState().status, 'acquiring')
  assert.deepEqual(fixture.getPositionOptions(), {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15_000,
  })
  fixture.succeed()
  fixture.succeed()
  assert.deepEqual(observations, [1, 2])
  assert.equal(fixture.source.getState().status, 'live')

  fixture.succeed(0)
  assert.equal(fixture.source.getState().status, 'live')
  assert.deepEqual(observations, [1, 2, 3])

  fixture.source.stop()
  assert.deepEqual(fixture.cleared, [42])
  assert.equal(fixture.source.getState().status, 'permission-required')

  fixture.source.start()
  fixture.succeed()
  assert.deepEqual(observations, [1, 2, 3, 4])
})

test('requests one fresh fix for newly connected viewers only when the last fix is old', () => {
  const fixture = createFixture()
  fixture.source.start()
  fixture.succeed()
  fixture.setNow(20_000)
  fixture.source.refresh()
  assert.equal(fixture.getRefreshCount(), 0)

  fixture.setNow(50_000)
  fixture.source.refresh()
  fixture.source.refresh()
  assert.equal(fixture.getRefreshCount(), 1)

  fixture.setNow(111_000)
  fixture.source.refresh()
  assert.equal(fixture.getRefreshCount(), 2)
})

test('moves observations through live, delayed, and stale states', () => {
  const fixture = createFixture()
  fixture.source.start()
  fixture.succeed()
  assert.equal(fixture.source.getState().status, 'live')

  fixture.setNow(16_000)
  fixture.runTimers()
  assert.equal(fixture.source.getState().status, 'delayed')

  fixture.setNow(31_000)
  fixture.runTimers()
  assert.equal(fixture.source.getState().status, 'stale')
})

test('reports denied and unavailable capabilities explicitly', () => {
  const fixture = createFixture()
  fixture.source.start()
  fixture.deny()
  assert.equal(fixture.source.getState().status, 'denied')
  assert.deepEqual(fixture.cleared, [42])

  const unavailable = createBrowserLocationSource({
    sourceId: 'unavailable-browser',
    geolocation: undefined,
  })
  assert.equal(unavailable.getState().status, 'unavailable')
  unavailable.start()
  assert.equal(unavailable.getState().status, 'unavailable')
})

test('clears an asynchronous watch that resolves after stop', async () => {
  let resolveWatch: ((watchId: number) => void) | undefined
  const cleared: number[] = []
  const source = createBrowserLocationSource({
    sourceId: 'async-platform',
    geolocation: {
      watchPosition: () =>
        new Promise<number>((resolve) => {
          resolveWatch = resolve
        }),
      clearWatch: async (watchId) => {
        cleared.push(watchId)
      },
    },
  })

  source.start()
  source.stop()
  resolveWatch?.(17)
  await Promise.resolve()

  assert.deepEqual(cleared, [17])
  assert.equal(source.getState().status, 'permission-required')
})

test('does not register duplicate watches while a start is pending', async () => {
  let resolveWatch: ((watchId: number) => void) | undefined
  let registrations = 0
  const source = createBrowserLocationSource({
    sourceId: 'pending-platform',
    geolocation: {
      watchPosition: () => {
        registrations += 1
        return new Promise<number>((resolve) => {
          resolveWatch = resolve
        })
      },
      clearWatch: () => undefined,
    },
  })

  source.start()
  source.start()
  assert.equal(registrations, 1)
  resolveWatch?.(18)
  await Promise.resolve()
  source.start()
  assert.equal(registrations, 1)
})
