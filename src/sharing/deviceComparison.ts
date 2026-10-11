import { defineFrpServiceProtocol } from '@taskyon/protocol'
import { z } from 'zod'
import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'

export const DEVICE_COMPARISON_PROTOCOL = '/constellation/device-comparison/1.0.0'
export const COMPARISON_TTL_MS = 120_000
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const commitRequest = z
  .object({ shareId: z.string().min(16).max(64), commitment: token, proof: token })
  .strict()
const challengeResponse = z
  .object({ challenge: token, expiresAt: z.number().int().positive(), proof: token })
  .strict()
const revealRequest = z.object({ nonce: token, proof: token }).strict()
export const deviceComparisonProtocol = defineFrpServiceProtocol({
  service: 'comparison',
  id: 'dev.constellation.device-comparison',
  version: '1',
  commands: {
    commit: { request: commitRequest, response: challengeResponse, defaultTimeoutMs: 5_000 },
    reveal: {
      request: revealRequest,
      response: z.object({ proof: token }).strict(),
      defaultTimeoutMs: 5_000,
    },
  },
  streams: {},
})

export interface ComparisonBinding {
  readonly shareId: string
  readonly sourcePeerId: string
  readonly viewerPeerId: string
}
export const DeviceComparison = z
  .object({
    shareId: z.string().min(16).max(64),
    ownPeerId: z.string().min(1).max(256),
    peerId: z.string().min(1).max(256),
    role: z.enum(['sender', 'viewer']),
    challenge: token,
    letters: z.string().regex(/^[A-Z]{4}$/),
    expiresAt: z.number().int().positive(),
    confirmedAt: z.number().int().positive().optional(),
  })
  .strict()
export type DeviceComparison = z.output<typeof DeviceComparison>
export const ComparisonBudget = z
  .object({
    shareId: z.string().min(16).max(64),
    ownPeerId: z.string().min(1).max(256),
    attempts: z.number().int().min(1).max(3),
  })
  .strict()
export type ComparisonBudget = z.output<typeof ComparisonBudget>

const encode = (values: readonly unknown[]) => new TextEncoder().encode(JSON.stringify(values))
const identity = (binding: ComparisonBinding) => [
  binding.shareId,
  binding.sourcePeerId,
  binding.viewerPeerId,
]
const nonce = () => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
export const comparisonProof = async (
  secret: Uint8Array,
  domain: string,
  values: readonly unknown[],
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        encode(['constellation-device-comparison-v1', domain, ...values]),
      ),
    ),
  )
}
const verify = async (
  secret: Uint8Array,
  domain: string,
  values: readonly unknown[],
  proof: string,
) => {
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(base64UrlToBytes(proof)).buffer,
    encode(['constellation-device-comparison-v1', domain, ...values]),
  )
}
const commitmentFor = async (binding: ComparisonBinding, random: string) =>
  bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encode(['constellation-device-commit-v1', ...identity(binding), random]),
      ),
    ),
  )

// Rejection sampling avoids modulo bias over the 26^4 comparison space.
export const comparisonLetters = async (
  secret: Uint8Array,
  transcript: readonly unknown[],
): Promise<string> => {
  const space = 26 ** 4
  for (let counter = 0; ; counter++) {
    const bytes = base64UrlToBytes(
      await comparisonProof(secret, 'letters', [...transcript, counter]),
    )
    let value = new DataView(Uint8Array.from(bytes).buffer).getUint32(0)
    if (value >= Math.floor(2 ** 32 / space) * space) continue
    value %= space
    return Array.from({ length: 4 }, () => {
      const letter = String.fromCharCode(65 + (value % 26))
      value = Math.floor(value / 26)
      return letter
    }).join('')
  }
}

export const reserveComparisonAttempt = async (
  budgets: ComparisonBudget[],
  shareId: string,
  ownPeerId: string,
  persist: () => Promise<void>,
): Promise<void> => {
  let budget = budgets.find((entry) => entry.shareId === shareId && entry.ownPeerId === ownPeerId)
  if (!budget) {
    if (budgets.length >= 256) throw new Error('Device comparison attempt storage is full.')
    budget = { shareId, ownPeerId, attempts: 1 }
    budgets.push(budget)
  } else {
    if (budget.attempts >= 3) throw new Error('Device comparison attempts exhausted for this link.')
    budget.attempts++
  }
  // Reserve synchronously and persist before any challenge leaves this device.
  // A failed save burns the in-memory attempt and releases no challenge.
  await persist()
}

export const createComparisonCommit = async (secret: Uint8Array, binding: ComparisonBinding) => {
  const random = nonce()
  const commitment = await commitmentFor(binding, random)
  return {
    nonce: random,
    request: {
      shareId: binding.shareId,
      commitment,
      proof: await comparisonProof(secret, 'commit', [...identity(binding), commitment]),
    },
  }
}

export const createComparisonResponder = (dependencies: {
  authorize: (shareId: string) => Promise<{ binding: ComparisonBinding; secret: Uint8Array }>
  reserve: (binding: ComparisonBinding) => Promise<void>
  now: () => number
  complete: (result: {
    binding: ComparisonBinding
    challenge: string
    letters: string
    expiresAt: number
  }) => void
}) => {
  let used = false
  let cancelled = false
  let pending:
    | {
        binding: ComparisonBinding
        secret: Uint8Array
        commitment: string
        challenge: string
        expiresAt: number
      }
    | undefined
  return {
    cancel: () => {
      cancelled = true
      pending = undefined
    },
    commit: async (input: z.output<typeof commitRequest>) => {
      if (used || cancelled) throw new Error('Device comparison denied.')
      used = true
      const request = commitRequest.parse({
        shareId: input.shareId,
        commitment: input.commitment,
        proof: input.proof,
      })
      const { binding, secret } = await dependencies.authorize(request.shareId)
      if (
        !(await verify(secret, 'commit', [...identity(binding), request.commitment], request.proof))
      )
        throw new Error('Device comparison denied.')
      await dependencies.reserve(binding)
      if (cancelled) throw new Error('Device comparison denied.')
      const challenge = nonce()
      const expiresAt = dependencies.now() + COMPARISON_TTL_MS
      pending = { binding, secret, commitment: request.commitment, challenge, expiresAt }
      return {
        challenge,
        expiresAt,
        proof: await comparisonProof(secret, 'challenge', [
          ...identity(binding),
          request.commitment,
          challenge,
          expiresAt,
        ]),
      }
    },
    reveal: async (input: z.output<typeof revealRequest>) => {
      const active = pending
      pending = undefined
      if (!active || cancelled || dependencies.now() >= active.expiresAt)
        throw new Error('Device comparison denied.')
      const request = revealRequest.parse({ nonce: input.nonce, proof: input.proof })
      const { binding, secret, commitment, challenge, expiresAt } = active
      await dependencies.authorize(binding.shareId)
      const transcript = [...identity(binding), commitment, challenge, expiresAt, request.nonce]
      if (
        commitment !== (await commitmentFor(binding, request.nonce)) ||
        !(await verify(secret, 'reveal', transcript, request.proof))
      )
        throw new Error('Device comparison denied.')
      const letters = await comparisonLetters(secret, transcript)
      if (cancelled || dependencies.now() >= expiresAt) throw new Error('Device comparison denied.')
      dependencies.complete({ binding, challenge, letters, expiresAt })
      return { proof: await comparisonProof(secret, 'complete', transcript) }
    },
  }
}

export const finishComparison = async (
  secret: Uint8Array,
  binding: ComparisonBinding,
  commit: Awaited<ReturnType<typeof createComparisonCommit>>,
  response: z.output<typeof challengeResponse>,
  reveal: (request: z.output<typeof revealRequest>) => Promise<{ proof: string }>,
) => {
  const challenge = challengeResponse.parse({
    challenge: response.challenge,
    expiresAt: response.expiresAt,
    proof: response.proof,
  })
  const prefix = [
    ...identity(binding),
    commit.request.commitment,
    challenge.challenge,
    challenge.expiresAt,
  ]
  if (!(await verify(secret, 'challenge', prefix, challenge.proof)))
    throw new Error('Device comparison denied.')
  const transcript = [...prefix, commit.nonce]
  const completed = await reveal({
    nonce: commit.nonce,
    proof: await comparisonProof(secret, 'reveal', transcript),
  })
  if (!(await verify(secret, 'complete', transcript, completed.proof)))
    throw new Error('Device comparison denied.')
  return {
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
    letters: await comparisonLetters(secret, transcript),
  }
}

// Stream IDs are only unique within a muxer. Find the exact stream object on
// an authenticated live connection before using the invitation identity.
export const requireComparisonStreamPeer = <Stream>(
  stream: Stream,
  connections: readonly {
    readonly streams: readonly Stream[]
    readonly status: string
    readonly remotePeer: { toString: () => string }
  }[],
  expectedPeerId: string,
): void => {
  const connection = connections.find((candidate) => candidate.streams.includes(stream))
  if (connection?.status !== 'open' || connection.remotePeer.toString() !== expectedPeerId)
    throw new Error('Device comparison authenticated peer mismatch.')
}
