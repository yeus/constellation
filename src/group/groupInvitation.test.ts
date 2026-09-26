import assert from 'node:assert/strict'
import test from 'node:test'

import { base64UrlToText, bytesToBase64Url, textToBase64Url } from '../sharing/encoding.ts'
import { createGroupInvitation, parseGroupInvitation } from './groupInvitation.ts'

const randomBytes = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => index + 1)

test('a valid bounded Group invitation verifies without contacting its creator', async () => {
  const now = Date.now()
  const invitation = await createGroupInvitation({
    baseUrl: 'https://constellation.example/',
    expiresAt: now + 10_000,
    randomBytes,
  })

  assert.equal(new URL(invitation.url).search, '')
  assert.match(new URL(invitation.url).hash, /^#group=/)
  assert.equal(invitation.groupPrivateKey.type, 'Ed25519')
  assert.deepEqual(await parseGroupInvitation(invitation.url, now), invitation.capability)
  await assert.rejects(parseGroupInvitation(invitation.url, now + 10_000), /expired/i)
})

test('changing a Group invitation after signing invalidates it', async () => {
  const now = Date.now()
  const invitation = await createGroupInvitation({
    baseUrl: 'https://constellation.example/',
    expiresAt: now + 10_000,
    randomBytes,
  })
  const original = JSON.parse(base64UrlToText(new URL(invitation.url).hash.slice('#group='.length)))
  const tampered = (field: string, value: unknown): string => {
    const url = new URL(invitation.url)
    url.hash = `group=${textToBase64Url(JSON.stringify({ ...original, [field]: value }))}`
    return url.toString()
  }

  for (const [field, value] of [
    ['groupId', bytesToBase64Url(new Uint8Array(16).fill(42))],
    ['secret', bytesToBase64Url(new Uint8Array(32).fill(42))],
    ['expiresAt', now + 20_000],
    ['signature', bytesToBase64Url(new Uint8Array(64).fill(42))],
  ] as const) {
    await assert.rejects(parseGroupInvitation(tampered(field, value), now))
  }

  const other = await createGroupInvitation({
    baseUrl: 'https://constellation.example/',
    expiresAt: now + 10_000,
    randomBytes,
  })
  await assert.rejects(
    parseGroupInvitation(tampered('groupPublicKey', other.capability.groupPublicKey), now),
  )
  assert.notEqual(other.capability.groupPublicKey, invitation.capability.groupPublicKey)
  await assert.rejects(parseGroupInvitation(tampered('role', 'admin'), now))
})

test('Group invitations reject unbounded and oversized bearer grants', async () => {
  const now = Date.now()
  const invitation = await createGroupInvitation({
    baseUrl: 'https://constellation.example/',
    expiresAt: now + 10_000,
    randomBytes,
  })
  const url = new URL(invitation.url)
  const capability = JSON.parse(base64UrlToText(url.hash.slice('#group='.length)))
  url.hash = `group=${textToBase64Url(JSON.stringify({ ...capability, expiresAt: null }))}`
  await assert.rejects(parseGroupInvitation(url.toString(), now))
  await assert.rejects(
    parseGroupInvitation(`https://constellation.example/#group=${'a'.repeat(1_801)}`, now),
    /too large/i,
  )
  await assert.rejects(
    createGroupInvitation({
      baseUrl: 'https://constellation.example/',
      expiresAt: now - 1,
      randomBytes,
    }),
    /expired/i,
  )
})
