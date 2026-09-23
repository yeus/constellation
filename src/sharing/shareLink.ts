import { z } from 'zod'

import { base64UrlToText, bytesToBase64Url, textToBase64Url } from './encoding.ts'

export const SHARE_LINK_VERSION = 1 as const
export const MAX_SHARE_FRAGMENT_LENGTH = 1_800

const ShareCapabilitySchema = z.object({
  v: z.literal(SHARE_LINK_VERSION),
  shareId: z.string().min(16).max(64),
  secret: z.string().min(43).max(64),
  sourcePeerId: z.string().min(1).max(256),
  addresses: z.array(z.string().min(1).max(512)).max(4),
  expiresAt: z.number().int().positive().nullable(),
})

export type ShareCapability = z.output<typeof ShareCapabilitySchema>

export const createShareInvitation = (options: {
  baseUrl: string
  sourcePeerId: string
  addresses: readonly string[]
  expiresAt: number | null
  randomBytes?: (length: number) => Uint8Array
}): { url: string; capability: ShareCapability } => {
  const randomBytes =
    options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)))
  const capability = ShareCapabilitySchema.parse({
    v: SHARE_LINK_VERSION,
    shareId: bytesToBase64Url(randomBytes(16)),
    secret: bytesToBase64Url(randomBytes(32)),
    sourcePeerId: options.sourcePeerId,
    addresses: [...options.addresses],
    expiresAt: options.expiresAt,
  })
  const fragment = textToBase64Url(JSON.stringify(capability))
  if (fragment.length > MAX_SHARE_FRAGMENT_LENGTH) {
    throw new RangeError('The share invitation is too large for a preview-safe link.')
  }
  const url = new URL(options.baseUrl)
  url.search = ''
  url.hash = `share=${fragment}`
  return { url: url.toString(), capability }
}

export const parseShareInvitation = (value: string, now = Date.now()): ShareCapability => {
  const url = new URL(value)
  const prefix = '#share='
  if (!url.hash.startsWith(prefix))
    throw new TypeError('The URL does not contain a share invitation.')
  const fragment = url.hash.slice(prefix.length)
  if (fragment.length > MAX_SHARE_FRAGMENT_LENGTH)
    throw new RangeError('The share invitation is too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlToText(fragment))
  } catch {
    throw new TypeError('The share invitation is malformed.')
  }
  const capability = ShareCapabilitySchema.parse(parsed)
  if (capability.expiresAt !== null && now >= capability.expiresAt) {
    throw new Error('The share invitation has expired.')
  }
  return capability
}
