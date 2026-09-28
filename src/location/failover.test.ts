import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserGeolocation, BrowserPosition } from './browser.ts'
import { createFailoverGeolocation } from './failover.ts'

const position: BrowserPosition = {
  timestamp: 1_000,
  coords: {
    latitude: 40,
    longitude: -70,
    accuracy: 800,
    altitude: null,
    heading: null,
    speed: null,
  },
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const fixture = () => {
  const events: string[] = []
  const timers = new Map<number, () => void>()
  let nativeSuccess: ((value: BrowserPosition) => void) | undefined
  let nativeError: ((error: { code: number }) => void) | undefined
  let webSuccess: ((value: BrowserPosition) => void) | undefined
  let timerId = 0
  const native: BrowserGeolocation = {
    watchPosition: (success, error) => {
      events.push('native-start')
      nativeSuccess = success
      nativeError = error
      return 7
    },
    clearWatch: (id) => {
      events.push(`native-stop:${id}`)
    },
  }
  const web: BrowserGeolocation = {
    watchPosition: (success) => {
      events.push('web-start')
      webSuccess = success
      return 8
    },
    clearWatch: (id) => {
      events.push(`web-stop:${id}`)
    },
  }
  const geolocation = createFailoverGeolocation(native, web, {
    setTimer: (callback, delay) => {
      assert.equal(delay, 20_000)
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
  })
  return {
    geolocation,
    events,
    nativeSuccess: () => nativeSuccess?.(position),
    nativeError: (code: number) => nativeError?.({ code }),
    webSuccess: () => webSuccess?.(position),
    timeout: () => [...timers.values()].forEach((callback) => callback()),
  }
}

test('uses native Android location when it produces a fix', async () => {
  const run = fixture()
  const received: BrowserPosition[] = []
  const id = await run.geolocation.watchPosition((value) => received.push(value))
  run.nativeSuccess()
  run.timeout()
  assert.deepEqual(received, [position])
  assert.deepEqual(run.events, ['native-start'])
  await run.geolocation.clearWatch(id)
  assert.deepEqual(run.events, ['native-start', 'native-stop:7'])
})

test('hands off after twenty seconds without a first native fix and ignores late callbacks', async () => {
  const run = fixture()
  const received: BrowserPosition[] = []
  const id = await run.geolocation.watchPosition((value) => received.push(value))
  run.timeout()
  run.nativeSuccess()
  await settle()
  run.webSuccess()
  assert.deepEqual(received, [position])
  assert.deepEqual(run.events, ['native-start', 'native-stop:7', 'web-start'])
  await run.geolocation.clearWatch(id)
  assert.deepEqual(run.events.at(-1), 'web-stop:8')
})

test('falls back on a technical native error but never after permission denial', async () => {
  const failed = fixture()
  const id = await failed.geolocation.watchPosition(() => undefined)
  failed.nativeError(2)
  await settle()
  assert.deepEqual(failed.events, ['native-start', 'native-stop:7', 'web-start'])
  await failed.geolocation.clearWatch(id)

  const denied = fixture()
  const codes: number[] = []
  await denied.geolocation.watchPosition(
    () => undefined,
    (error) => codes.push(error.code),
  )
  denied.nativeError(1)
  denied.timeout()
  assert.deepEqual(codes, [1])
  assert.deepEqual(denied.events, ['native-start'])
})

test('cancels an in-flight native registration without leaving a watch behind', async () => {
  let resolveRegistration: ((id: number) => void) | undefined
  const stopped: number[] = []
  const native: BrowserGeolocation = {
    watchPosition: () =>
      new Promise((resolve) => {
        resolveRegistration = resolve
      }),
    clearWatch: (id) => {
      stopped.push(id)
    },
  }
  const geolocation = createFailoverGeolocation(native, undefined)
  const id = await geolocation.watchPosition(() => undefined)
  await geolocation.clearWatch(id)
  resolveRegistration?.(19)
  await Promise.resolve()
  assert.deepEqual(stopped, [19])
})

test('does not start WebView until native watch cleanup resolves', async () => {
  const events: string[] = []
  let nativeError: ((error: { code: number }) => void) | undefined
  let finishCleanup: (() => void) | undefined
  const native: BrowserGeolocation = {
    watchPosition: (_success, error) => {
      nativeError = error
      events.push('native-start')
      return 1
    },
    clearWatch: () =>
      new Promise<void>((resolve) => {
        events.push('native-stop')
        finishCleanup = resolve
      }),
  }
  const webview: BrowserGeolocation = {
    watchPosition: () => {
      events.push('web-start')
      return 2
    },
    clearWatch: () => {
      events.push('web-stop')
    },
  }
  const geolocation = createFailoverGeolocation(native, webview)
  const id = await geolocation.watchPosition(() => undefined)
  nativeError?.({ code: 2 })
  assert.deepEqual(events, ['native-start', 'native-stop'])
  finishCleanup?.()
  await settle()
  assert.deepEqual(events, ['native-start', 'native-stop', 'web-start'])
  await geolocation.clearWatch(id)
})

test('does not time out while native permission or registration is pending', async () => {
  let finishRegistration: ((id: number) => void) | undefined
  const timers = new Map<number, () => void>()
  const calls: string[] = []
  const native: BrowserGeolocation = {
    watchPosition: () =>
      new Promise<number>((resolve) => {
        finishRegistration = resolve
      }),
    clearWatch: () => {
      calls.push('native-stop')
    },
  }
  const webview: BrowserGeolocation = {
    watchPosition: () => {
      calls.push('web-start')
      return 2
    },
    clearWatch: () => undefined,
  }
  const geolocation = createFailoverGeolocation(native, webview, {
    setTimer: (callback) => {
      timers.set(1, callback)
      return 1
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
  })
  const id = await geolocation.watchPosition(() => undefined)
  assert.equal(timers.size, 0)
  finishRegistration?.(1)
  await settle()
  assert.equal(timers.size, 1)
  await geolocation.clearWatch(id)
  assert.deepEqual(calls, ['native-stop'])
})
