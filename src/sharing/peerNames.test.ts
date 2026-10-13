import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PeerNamePreference,
  displayedPeerName,
  advertisedPeerName,
  receiveAdvertisedName,
  nameAfterContact,
  peerNamesProtocol,
} from './peerNames.ts'

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

test('initial advertisements are adopted while later updates remain pending', () => {
  const initial = PeerNamePreference.parse({
    peerId: 'synthetic-peer',
    associateNames: false,
    sharedName: null,
    receivedName: null,
  })
  const first = receiveAdvertisedName(initial, 'River')
  assert.equal(displayedPeerName(first, undefined, 'Fallback'), 'River')
  const updated = receiveAdvertisedName(first, 'Forest')
  assert.equal(updated.receivedName, 'Forest')
  assert.equal(displayedPeerName(updated, undefined, 'Fallback'), 'River')
  assert.equal(displayedPeerName(updated, 'Family', 'Fallback'), 'Family')
  assert.equal(receiveAdvertisedName(updated, null).acceptedName, 'River')
  assert.equal(receiveAdvertisedName(initial, 'Forest', 'Link name').acceptedName, 'Link name')
})

test('contact names replace pending aliases but preserve accepted and private names', () => {
  assert.equal(
    nameAfterContact(
      { localName: 'Amber Otter', usesPrivateName: false, approvalPending: true },
      'River',
      undefined,
      'Fallback',
    ),
    'River',
  )
  assert.equal(
    nameAfterContact(
      { localName: 'Family', usesPrivateName: true, approvalPending: true },
      'River',
      undefined,
      'Fallback',
    ),
    'Family',
  )
  assert.equal(
    nameAfterContact(
      { localName: 'River', usesPrivateName: false },
      'Forest',
      undefined,
      'Fallback',
    ),
    'River',
  )
  assert.equal(
    nameAfterContact(
      { localName: 'Fallback', usesPrivateName: false },
      'River',
      undefined,
      'Fallback',
    ),
    'River',
  )
  assert.equal(nameAfterContact(undefined, 'River', undefined, 'Fallback'), 'River')
  assert.equal(nameAfterContact(undefined, 'River', 'Family', 'Fallback'), 'Family')
})

test('advertised names use the live profile or the authenticated link label', () => {
  assert.equal(advertisedPeerName(undefined, 'Link name'), 'Link name')
  const preference = PeerNamePreference.parse({
    peerId: 'synthetic-peer',
    associateNames: false,
    sharedName: null,
    receivedName: 'New name',
    acceptedName: 'Old name',
  })
  assert.equal(advertisedPeerName(preference, 'Link name'), 'New name')
  assert.equal(advertisedPeerName({ ...preference, receivedName: null }, 'Link name'), 'Link name')
  assert.equal(advertisedPeerName({ ...preference, receivedName: null }), undefined)
})
