import { bytesToBase64Url } from './encoding.ts'

export interface RedemptionProofInput {
  readonly shareId: string
  readonly sourcePeerId: string
  readonly viewerPeerId: string
  readonly viewerNonce: string
}

const proofMessage = (input: RedemptionProofInput): Uint8Array =>
  new TextEncoder().encode(
    [
      'constellation-share-v1',
      input.shareId,
      input.sourcePeerId,
      input.viewerPeerId,
      input.viewerNonce,
    ].join('\0'),
  )

const importHmacKey = (secret: Uint8Array, usage: KeyUsage[]) =>
  crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  )

export const createRedemptionProof = async (
  secret: Uint8Array,
  input: RedemptionProofInput,
): Promise<string> => {
  const key = await importHmacKey(secret, ['sign'])
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, Uint8Array.from(proofMessage(input)).buffer),
    ),
  )
}

export const verifyRedemptionProof = async (
  secret: Uint8Array,
  input: RedemptionProofInput,
  proof: string,
): Promise<boolean> => {
  const key = await importHmacKey(secret, ['verify'])
  try {
    const normalized = proof.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return await crypto.subtle.verify(
      'HMAC',
      key,
      Uint8Array.from(bytes).buffer,
      Uint8Array.from(proofMessage(input)).buffer,
    )
  } catch {
    return false
  }
}
