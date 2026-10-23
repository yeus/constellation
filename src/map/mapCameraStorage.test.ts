import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { bytesToBase64Url } from '../sharing/encoding.ts'
import { createBrowserLocationSource } from '../location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../sharing/sharingRuntime.ts'
import type { PrivateState } from '../sharing/privateStore.ts'

test('map camera is restored from protected state after restart, without auto-centering at world zoom', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  let runtime: ReturnType<typeof createSharingRuntime> | undefined
  try {
    let saved: PrivateState = {
      version: 1,
      privateKey: bytesToBase64Url(privateKeyToProtobuf(await generateKeyPair('Ed25519'))),
      shares: [],
      followed: [],
    }
    const create = () =>
      createSharingRuntime(
        createBrowserLocationSource({ sourceId: 'camera-test', geolocation: undefined }),
        'https://example.test/',
        {
          load: async () => saved,
          save: async (next) => {
            saved = structuredClone(next)
          },
        },
        'external',
      )
    runtime = create()
    let state!: SharingRuntimeState
    runtime.subscribe((next) => {
      state = next
    })
    assert.equal(state.privateStateReady, false)
    await runtime.initialize()
    assert.equal(state.privateStateReady, true)
    assert.equal(state.mapCamera, undefined)
    runtime.setMapCamera({ longitude: 0, latitude: 20, zoom: 1.5 })
    await runtime.stop()
    assert.equal(saved.mapCamera, undefined)
    runtime = create()
    runtime.subscribe((next) => {
      state = next
    })
    await runtime.initialize()
    runtime.setMapCamera({ longitude: -117.16, latitude: 32.72, zoom: 17.5 })
    await runtime.stop()
    assert.deepEqual(saved.mapCamera, { longitude: -117.16, latitude: 32.72, zoom: 17.5 })
    runtime = create()
    runtime.subscribe((next) => {
      state = next
    })
    await runtime.initialize()
    assert.deepEqual(state.mapCamera, saved.mapCamera)
  } finally {
    await runtime?.stop()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
