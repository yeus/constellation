import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { zlibSync } from 'fflate'

import { createShareInvitation, parseShareInvitation, shareInvitationUrl } from './shareLink.ts'

const randomBytes = (length: number) => Uint8Array.from({ length }, (_, index) => index + 1)

test('keeps every capability field in the URL fragment', async () => {
  const invitation = await createShareInvitation({
    baseUrl: 'https://constellation.example/share',
    sourcePeerId: 'synthetic-source-peer',
    addresses: ['/dns4/relay.example/tcp/443/wss/p2p/synthetic'],
    expiresAt: 10_000,
    randomBytes,
  })
  const url = new URL(invitation.url)

  assert.equal(url.search, '')
  assert.equal(url.pathname, '/share')
  assert.match(url.hash, /^#share=/)
  assert.deepEqual(parseShareInvitation(invitation.url, 1), invitation.capability)
})

test('rejects expired and oversized invitations', async () => {
  const invitation = await createShareInvitation({
    baseUrl: 'https://constellation.example/share',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: 10,
    randomBytes,
  })

  assert.throws(() => parseShareInvitation(invitation.url, 10), /expired/i)
  assert.throws(
    () => parseShareInvitation(`https://constellation.example/share#share=${'a'.repeat(1_801)}`, 1),
    /too large/i,
  )
})

test('separate shares use independent capability identifiers and secrets', async () => {
  const first = await createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes: (length) => new Uint8Array(length).fill(1),
  })
  const second = await createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes: (length) => new Uint8Array(length).fill(2),
  })
  assert.notEqual(first.capability.shareId, second.capability.shareId)
  assert.notEqual(first.capability.secret, second.capability.secret)
})

test('rejects unknown capability fields', async () => {
  const invitation = await createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes,
  })
  const url = new URL(invitation.url)
  url.hash = `share=${Buffer.from(JSON.stringify({ ...invitation.capability, requiredFutureBehavior: true })).toString('base64url')}`
  assert.throws(() => parseShareInvitation(url.toString()), /unrecognized|unknown/i)
})

test('accepts legacy JSON links without changing their fields', async () => {
  const { capability } = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes,
  })
  const legacy = `https://example.test/#share=${Buffer.from(JSON.stringify(capability)).toString('base64url')}`
  assert.deepEqual(parseShareInvitation(legacy), capability)
})

test('packs and selectively compresses real-shaped invitations with every field intact', async () => {
  const sourcePeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const relayPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const relay = `/dns4/relay.example.test/tcp/443/wss/p2p/${relayPeerId}/p2p-circuit`
  const ownerPrivateKey = await generateKeyPair('Ed25519')
  for (const addresses of [[], [relay], [relay, `${relay}/webrtc/p2p/${sourcePeerId}`]]) {
    const { url, capability } = await createShareInvitation({
      baseUrl: 'https://example.test/',
      sourcePeerId,
      addresses,
      expiresAt: null,
      ownerPrivateKey,
    })
    const encoded = Buffer.from(new URL(url).hash.slice(7), 'base64url')
    assert.equal(encoded[0], 2, 'compact envelope version')
    assert.equal(encoded[1], addresses.length > 1 ? 1 : 0, 'compression only when it saves bytes')
    assert.deepEqual(parseShareInvitation(url), capability)
    assert.ok(
      url.length <
        0.7 *
          `https://example.test/#share=${Buffer.from(JSON.stringify(capability)).toString('base64url')}`
            .length,
    )
  }
})

test('rejects unknown versions, corrupt compression, truncated data and oversized expansion', () => {
  const url = (bytes: Uint8Array) =>
    `https://example.test/#share=${Buffer.from(bytes).toString('base64url')}`
  assert.throws(() => parseShareInvitation(url(new Uint8Array([3, 0]))), /unsupported/i)
  assert.throws(() => parseShareInvitation(url(new Uint8Array([2, 0, 1]))), /malformed/i)
  const compressed = zlibSync(new Uint8Array(100_000))
  assert.throws(
    () => parseShareInvitation(url(new Uint8Array([2, 1, ...compressed]))),
    /too large/i,
  )
  assert.throws(() => parseShareInvitation(url(new Uint8Array([2, 1, 0, 0, 0]))), /malformed/i)
})

test('preserves individually optional owner fields and noncanonical textual values', () => {
  const capability = {
    v: 1 as const,
    shareId: 'synthetic-share-id',
    secret: 'A'.repeat(43),
    sourcePeerId: 'synthetic-source-peer',
    addresses: ['synthetic-address'],
    expiresAt: null,
    ownerProof: 'synthetic-proof'.repeat(4),
  }
  assert.deepEqual(
    parseShareInvitation(shareInvitationUrl(capability, 'https://example.test/')),
    capability,
  )
})

test('return-share proof binds a link to its authenticated owner', async () => {
  const ownerKey = await generateKeyPair('Ed25519')
  const invitation = await createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes,
    ownerPrivateKey: ownerKey,
  })
  const { verifyReturnOwner } = await import('./shareLink.ts')
  assert.equal(
    await verifyReturnOwner(invitation.capability, invitation.capability.ownerPeerId),
    true,
  )
  assert.equal(await verifyReturnOwner(invitation.capability, 'another-owner'), false)
  assert.equal(
    await verifyReturnOwner({ ...invitation.capability, ownerProof: 'A'.repeat(64) }),
    false,
  )
})

test('serializing a selected transport preserves the original private grant and owner proof', async () => {
  const { shareInvitationUrl, verifyReturnOwner } = await import('./shareLink.ts')
  const original = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: ['/ip4/127.0.0.1/tcp/9111/ws', '/ip4/127.0.0.1/tcp/9111/ws/p2p-circuit/webrtc'],
    expiresAt: null,
    ownerPrivateKey: await generateKeyPair('Ed25519'),
  })
  const capability = { ...original.capability, addresses: [original.capability.addresses[1]!] }
  const parsed = parseShareInvitation(shareInvitationUrl(capability, original.url))
  assert.deepEqual(parsed, capability)
  assert.equal(parsed.shareId, original.capability.shareId)
  assert.equal(parsed.secret, original.capability.secret)
  assert.equal(await verifyReturnOwner(parsed, original.capability.ownerPeerId), true)
})
