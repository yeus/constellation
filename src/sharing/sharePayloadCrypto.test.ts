import assert from 'node:assert/strict'
import test from 'node:test'

import { LOCATION_PROFILE_V1, type LocationObservationV1 } from '../location/locationObservation.ts'
import { decryptLocationPayload, encryptLocationPayload } from './sharePayloadCrypto.ts'

const observation: LocationObservationV1 = {
  profile: LOCATION_PROFILE_V1,
  sourceId: 'synthetic-source',
  precision: 'exact',
  sequence: 7,
  capturedAt: 1_000,
  expiresAt: 31_000,
  latitude: 32.7157,
  longitude: -117.1611,
  accuracyMeters: 12,
}

const secret = (value: number) => new Uint8Array(32).fill(value)
const iv = (value: number) => (length: number) => new Uint8Array(length).fill(value)

test('round-trips an authenticated location payload within one share scope', async () => {
  const encrypted = await encryptLocationPayload(secret(1), 'synthetic-share-a', observation, iv(3))
  assert.equal(JSON.stringify(encrypted).includes('32.7157'), false)
  assert.deepEqual(
    await decryptLocationPayload(secret(1), 'synthetic-share-a', encrypted),
    observation,
  )
})

test('equivalent observations encrypt independently across transient share scopes', async () => {
  const first = await encryptLocationPayload(secret(1), 'synthetic-share-a', observation, iv(7))
  const second = await encryptLocationPayload(secret(2), 'synthetic-share-b', observation, iv(7))
  assert.notEqual(first.ciphertext, second.ciphertext)
  await assert.rejects(() => decryptLocationPayload(secret(1), 'synthetic-share-b', first))
  await assert.rejects(() => decryptLocationPayload(secret(2), 'synthetic-share-a', second))
})

test('fresh IVs make repeated observations unlinkable within a scope at the ciphertext level', async () => {
  const first = await encryptLocationPayload(secret(1), 'synthetic-share-a', observation, iv(1))
  const second = await encryptLocationPayload(secret(1), 'synthetic-share-a', observation, iv(2))
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ciphertext, second.ciphertext)
})
