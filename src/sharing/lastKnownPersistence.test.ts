import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { bytesToBase64Url } from './encoding.ts'
import { createShareInvitation } from './shareLink.ts'
import { createBrowserLocationSource } from '../location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from './sharingRuntime.ts'
import { savedFollowRecords } from './sharingProjection.ts'
import { decryptPrivateState, encryptPrivateState, type PrivateState } from './privateStore.ts'
import { LOCATION_PROFILE_V1 } from '../location/locationObservation.ts'

const observation = {
  profile: LOCATION_PROFILE_V1,
  sourceId: 'synthetic-publisher',
  precision: 'approximate' as const,
  sequence: 12,
  capturedAt: Date.now() - 3 * 60 * 60_000,
  expiresAt: Date.now() - 3 * 60 * 60_000 + 15_000,
  latitude: 11.223344,
  longitude: -77.665544,
  accuracyMeters: 2500,
  headingDegrees: 45,
  speedMps: 5,
}

test('persist only one minimal authorized fix: saved, unexpired and non-denied', () => {
  const base = {
    url: 'https://example.invalid/#share=synthetic',
    localName: 'Test peer',
    color: '#438ec9',
    saved: true,
    expiresAt: null,
    lastObservation: observation,
  }
  const persisted = savedFollowRecords([base])
  assert.equal(persisted[0]?.lastObservation?.latitude, observation.latitude)
  assert.equal(persisted[0]?.lastObservation?.accuracyMeters, observation.accuracyMeters)
  assert.equal(persisted[0]?.lastObservation?.headingDegrees, undefined)
  assert.equal(persisted[0]?.lastObservation?.speedMps, undefined)
  assert.equal(savedFollowRecords([{ ...base, saved: false }]).length, 0)
  assert.equal(
    savedFollowRecords([{ ...base, approvalPending: true }])[0]?.lastObservation,
    undefined,
  )
  assert.equal(
    savedFollowRecords([{ ...base, approvalDenied: true }])[0]?.lastObservation,
    undefined,
  )
  assert.equal(
    savedFollowRecords([{ ...base, terminal: 'revoked' }])[0]?.lastObservation,
    undefined,
  )
  assert.equal(
    savedFollowRecords([{ ...base, expiresAt: Date.now() - 10 }])[0]?.lastObservation,
    undefined,
  )
})

test('encrypted last fix survives restart but is removed on stop-following', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  let runtime: ReturnType<typeof createSharingRuntime> | undefined
  try {
    const invitation = await createShareInvitation({
      baseUrl: 'https://example.test/',
      sourcePeerId: 'synthetic-source-peer',
      addresses: [],
      expiresAt: null,
    })
    const identity = await generateKeyPair('Ed25519')
    let saved: PrivateState = {
      version: 1,
      privateKey: bytesToBase64Url(privateKeyToProtobuf(identity)),
      shares: [],
      followed: [
        {
          url: invitation.url,
          localName: 'Test peer',
          color: '#438ec9',
          lastObservation: observation,
        },
      ],
    }
    const secret = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
    const encrypted = await encryptPrivateState(saved, secret)
    assert.equal(JSON.stringify(encrypted).includes('11.223344'), false)
    saved = await decryptPrivateState(encrypted, secret)
    const makeRuntime = () =>
      createSharingRuntime(
        createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
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
    let visible!: SharingRuntimeState
    runtime.subscribe((state) => {
      visible = state
    })
    await runtime.initialize()
    assert.equal(visible.received.length, 1)
    assert.equal(visible.received[0]?.state, 'stale')
    assert.equal(visible.received[0]?.observation.latitude, observation.latitude)
    assert.equal(visible.following[0]?.lastLocationAt, observation.capturedAt)
    await runtime.stopFollowing(invitation.capability.shareId)
    assert.equal(visible.received.length, 0)
    assert.equal(saved.followed.length, 0)
    assert.equal(JSON.stringify(saved).includes('11.223344'), false)
  } finally {
    await runtime?.stop()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('revoked and expired follows scrub stored last fixes on restore', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  try {
    const key = await generateKeyPair('Ed25519')
    const identity = bytesToBase64Url(privateKeyToProtobuf(key))
    for (const kind of ['expired', 'revoked'] as const) {
      const invitation = await createShareInvitation({
        baseUrl: 'https://example.test/',
        sourcePeerId: 'synthetic-source-peer',
        addresses: [],
        expiresAt: kind === 'expired' ? Date.now() - 60_000 : null,
      })
      let saved: PrivateState = {
        version: 1,
        privateKey: identity,
        shares: [],
        followed: [
          {
            url: invitation.url,
            localName: 'Synthetic peer',
            color: '#438ec9',
            ...(kind === 'revoked' ? { endReason: 'revoked' as const } : {}),
            lastObservation: observation,
          },
        ],
      }
      const runtime = createSharingRuntime(
        createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
        'https://example.test/',
        {
          load: async () => saved,
          save: async (next) => {
            saved = structuredClone(next)
          },
        },
        'external',
      )
      let visible!: SharingRuntimeState
      runtime.subscribe((state) => {
        visible = state
      })
      try {
        await runtime.initialize()
        assert.equal(visible.received.length, 0, kind)
        assert.equal(saved.followed[0]?.lastObservation, undefined, kind)
      } finally {
        await runtime.stop()
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
