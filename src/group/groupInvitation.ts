import { generateKeyPair, publicKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys'
import { z } from 'zod'

import {
  base64UrlToBytes,
  base64UrlToText,
  bytesToBase64Url,
  textToBase64Url,
} from '../sharing/encoding.ts'
import { MAX_SHARE_FRAGMENT_LENGTH } from '../sharing/shareLink.ts'

const GroupInvitationFields = z.strictObject({
  v: z.literal(1),
  groupId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  groupPublicKey: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/),
  expiresAt: z.number().int().positive(),
})

const GroupInvitationCapability = GroupInvitationFields.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
})

export type GroupInvitationCapability = z.output<typeof GroupInvitationCapability>

const signatureMessage = (fields: z.output<typeof GroupInvitationFields>): Uint8Array =>
  new TextEncoder().encode(
    [
      'constellation-group-invitation-v1',
      fields.groupId,
      fields.secret,
      fields.groupPublicKey,
      String(fields.expiresAt),
    ].join('\0'),
  )

export const createGroupInvitation = async (options: {
  baseUrl: string
  expiresAt: number
  randomBytes?: (length: number) => Uint8Array
}) => {
  if (options.expiresAt <= Date.now()) throw new Error('The Group invitation has expired.')
  const groupPrivateKey = await generateKeyPair('Ed25519')
  const randomBytes =
    options.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)))
  const fields = GroupInvitationFields.parse({
    v: 1,
    groupId: bytesToBase64Url(randomBytes(16)),
    secret: bytesToBase64Url(randomBytes(32)),
    groupPublicKey: bytesToBase64Url(publicKeyToProtobuf(groupPrivateKey.publicKey)),
    expiresAt: options.expiresAt,
  })
  const capability = GroupInvitationCapability.parse({
    ...fields,
    signature: bytesToBase64Url(await groupPrivateKey.sign(signatureMessage(fields))),
  })
  const fragment = textToBase64Url(JSON.stringify(capability))
  if (fragment.length > MAX_SHARE_FRAGMENT_LENGTH) {
    throw new RangeError('The Group invitation is too large.')
  }
  const url = new URL(options.baseUrl)
  url.search = ''
  url.hash = `group=${fragment}`
  return { url: url.toString(), capability, groupPrivateKey }
}

export const parseGroupInvitation = async (
  value: string,
  now = Date.now(),
): Promise<GroupInvitationCapability> => {
  const url = new URL(value)
  if (!url.hash.startsWith('#group=')) {
    throw new TypeError('The URL does not contain a Group invitation.')
  }
  const fragment = url.hash.slice('#group='.length)
  if (fragment.length > MAX_SHARE_FRAGMENT_LENGTH) {
    throw new RangeError('The Group invitation is too large.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlToText(fragment))
  } catch {
    throw new TypeError('The Group invitation is malformed.')
  }
  const capability = GroupInvitationCapability.parse(parsed)
  if (now >= capability.expiresAt) throw new Error('The Group invitation has expired.')
  const publicKey = publicKeyFromProtobuf(base64UrlToBytes(capability.groupPublicKey))
  if (publicKey.type !== 'Ed25519') throw new Error('The Group invitation has an invalid issuer.')
  const { signature, ...fields } = capability
  if (!(await publicKey.verify(signatureMessage(fields), base64UrlToBytes(signature)))) {
    throw new Error('The Group invitation signature is invalid.')
  }
  return capability
}
