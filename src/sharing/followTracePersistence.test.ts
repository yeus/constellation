import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { bytesToBase64Url } from './encoding.ts'
import { createShareInvitation } from './shareLink.ts'
import { encryptPrivateState, decryptPrivateState, type PrivateState } from './privateStore.ts'
import { createBrowserLocationSource } from '../location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from './sharingRuntime.ts'
import { FOLLOW_TRACE_RETENTION_MS } from './followTrace.ts'

test('a subscriber opts into recording per saved share, restores that preference, and can delete it', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  let runtime: ReturnType<typeof createSharingRuntime> | undefined
  try {
    const source = await createShareInvitation({
      baseUrl: 'https://example.test/',
      sourcePeerId: 'synthetic-peer',
      addresses: [],
      expiresAt: null,
    })
    const key = await generateKeyPair('Ed25519')
    let saved: PrivateState = {
      version: 1,
      privateKey: bytesToBase64Url(privateKeyToProtobuf(key)),
      shares: [],
      followed: [{ url: source.url, localName: 'Synthetic person', color: '#438ec9' }],
    }
    const makeRuntime = () =>
      createSharingRuntime(
        createBrowserLocationSource({ sourceId: 'synthetic-local', geolocation: undefined }),
        'https://example.test/',
        {
          load: async () => saved,
          save: async (next) => {
            saved = structuredClone(next)
          },
        },
        'external',
      )
    runtime = makeRuntime()
    let state!: SharingRuntimeState
    runtime.subscribe((next) => {
      state = next
    })
    await runtime.initialize()
    assert.equal(state.following[0]?.traceEnabled, false)
    assert.equal(saved.followed[0]?.traceEnabled, undefined)
    await runtime.setFollowTraceEnabled(source.capability.shareId, true)
    assert.equal(saved.followed[0]?.traceEnabled, true)
    assert.deepEqual(saved.followed[0]?.trace, [])
    await runtime.stop()
    runtime = makeRuntime()
    runtime.subscribe((next) => {
      state = next
    })
    await runtime.initialize()
    assert.equal(state.following[0]?.traceEnabled, true)
    await runtime.setFollowTraceEnabled(source.capability.shareId, false)
    assert.equal(saved.followed[0]?.traceEnabled, undefined)
    assert.equal(saved.followed[0]?.trace, undefined)
  } finally {
    await runtime?.stop()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('stored opt-in location history is encrypted, bounded and not leaked into plain records', async () => {
  const now = Date.now()
  const trace = [
    {
      type: 'location' as const,
      receivedAt: now,
      capturedAt: now - 500,
      latitude: 32.712345,
      longitude: -117.161234,
      accuracyMeters: 1_000,
      precision: 'approximate' as const,
      sequence: 1,
    },
  ]
  const state: PrivateState = {
    version: 1,
    privateKey: 'A'.repeat(40),
    shares: [],
    followed: [
      {
        url: 'https://example.test/#synthetic',
        localName: 'Synthetic person',
        color: '#438ec9',
        traceEnabled: true,
        trace,
      },
    ],
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  const encrypted = await encryptPrivateState(state, key)
  assert.equal(JSON.stringify(encrypted).includes('32.712345'), false)
  assert.deepEqual((await decryptPrivateState(encrypted, key)).followed[0]?.trace, trace)
  assert.ok(FOLLOW_TRACE_RETENTION_MS === 86_400_000)
})
