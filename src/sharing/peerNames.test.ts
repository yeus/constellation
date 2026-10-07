import assert from 'node:assert/strict'
import test from 'node:test'
import { PeerNamePreference, displayedPeerName, peerNamesProtocol } from './peerNames.ts'

test('shared names stay separate from private nicknames and generated aliases', () => {
  const preference = PeerNamePreference.parse({
    peerId: 'synthetic-peer',
    associateNames: false,
    sharedName: null,
    receivedName: 'Alice',
  })
  assert.equal(displayedPeerName(preference, undefined, 'Amber Otter'), 'Alice')
  assert.equal(displayedPeerName(preference, 'Mum', 'Amber Otter'), 'Mum')
  assert.equal(preference.sharedName, null)
  assert.equal(
    displayedPeerName(
      { ...preference, nickname: 'Private', associateNames: false },
      undefined,
      'Fallback',
    ),
    'Alice',
  )
  assert.equal(
    displayedPeerName(
      { ...preference, nickname: 'Private', associateNames: true },
      undefined,
      'Fallback',
    ),
    'Private',
  )
})

test('name exchange requires a location session and never transports local nicknames', () => {
  const message = {
    type: 'peerNames.exchangeRequest',
    requestId: 'synthetic-request',
    shareId: 'synthetic-share-id',
    sessionId: 'synthetic-session-id',
    displayName: 'Alice',
  }
  assert.equal(peerNamesProtocol.message.safeParse(message).success, true)
  assert.equal(peerNamesProtocol.message.safeParse({ ...message, nickname: 'Mum' }).success, false)
  assert.equal(peerNamesProtocol.message.safeParse({ ...message, sessionId: '' }).success, false)
  assert.equal(peerNamesProtocol.message.safeParse({ ...message, displayName: null }).success, true)
})
