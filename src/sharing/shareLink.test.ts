import assert from 'node:assert/strict'
import test from 'node:test'

import { createShareInvitation, parseShareInvitation } from './shareLink.ts'

const randomBytes = (length: number) => Uint8Array.from({ length }, (_, index) => index + 1)

test('keeps every capability field in the URL fragment', () => {
  const invitation = createShareInvitation({
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

test('rejects expired and oversized invitations', () => {
  const invitation = createShareInvitation({
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

test('separate shares use independent capability identifiers and secrets', () => {
  const first = createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes: (length) => new Uint8Array(length).fill(1),
  })
  const second = createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes: (length) => new Uint8Array(length).fill(2),
  })
  assert.notEqual(first.capability.shareId, second.capability.shareId)
  assert.notEqual(first.capability.secret, second.capability.secret)
})

test('rejects unknown capability fields', () => {
  const invitation = createShareInvitation({
    baseUrl: 'https://constellation.example/',
    sourcePeerId: 'synthetic-source-peer',
    addresses: [],
    expiresAt: null,
    randomBytes,
  })
  const url = new URL(invitation.url)
  const encoded = url.hash.slice('#share='.length)
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  url.hash = `share=${Buffer.from(JSON.stringify({ ...payload, requiredFutureBehavior: true })).toString('base64url')}`
  assert.throws(() => parseShareInvitation(url.toString()), /unrecognized|unknown/i)
})
