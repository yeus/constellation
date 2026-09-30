import { z } from 'zod'

import {
  parseLocationObservationV1,
  type LocationObservationV1,
} from '../location/locationObservation.ts'
import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'

const PAYLOAD_INFO = new TextEncoder().encode('constellation-location-payload-v1')

const EncryptedLocationPayloadV1 = z
  .object({
    v: z.literal(1),
    iv: z.string().min(16).max(32),
    ciphertext: z.string().min(16).max(4_096),
  })
  .strict()

export type EncryptedLocationPayload = z.output<typeof EncryptedLocationPayloadV1>

const payloadAssociatedData = (shareId: string): Uint8Array =>
  new TextEncoder().encode(`constellation-location-payload-v1\0${shareId}`)

const derivePayloadKey = async (secret: Uint8Array): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32).buffer,
      info: Uint8Array.from(PAYLOAD_INFO).buffer,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export const encryptLocationPayload = async (
  secret: Uint8Array,
  shareId: string,
  observation: LocationObservationV1,
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): Promise<EncryptedLocationPayload> => {
  const iv = randomBytes(12)
  if (iv.length !== 12) throw new RangeError('Location payload IV must contain 12 bytes.')
  const key = await derivePayloadKey(secret)
  const plaintext = new TextEncoder().encode(
    JSON.stringify(parseLocationObservationV1(observation)),
  )
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(iv).buffer,
      additionalData: Uint8Array.from(payloadAssociatedData(shareId)).buffer,
    },
    key,
    plaintext,
  )
  return {
    v: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  }
}

export const decryptLocationPayload = async (
  secret: Uint8Array,
  shareId: string,
  value: unknown,
): Promise<LocationObservationV1> => {
  const payload = EncryptedLocationPayloadV1.parse(value)
  const key = await derivePayloadKey(secret)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(base64UrlToBytes(payload.iv)).buffer,
      additionalData: Uint8Array.from(payloadAssociatedData(shareId)).buffer,
    },
    key,
    Uint8Array.from(base64UrlToBytes(payload.ciphertext)),
  )
  return parseLocationObservationV1(JSON.parse(new TextDecoder().decode(plaintext)))
}
