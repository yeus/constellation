import assert from 'node:assert/strict'
import test from 'node:test'
import {
  protectActivePeerHistory,
  clearPeerHistory,
  restoreFailedPeerHistoryClear,
} from './peerHistory.ts'

test('cleanup preserves active peers and links but clears inactive records regardless of their reported time', () => {
  const protection = protectActivePeerHistory(
    [
      {
        shareId: 'active-share',
        recipientPeerId: 'bound-peer',
        viewers: [{ peerId: 'viewer-peer', fingerprint: 'synthetic', lastSeenAt: 1 }],
      },
    ],
    [
      { shareId: 'active-follow', peerId: 'follow-peer', status: 'live' },
      { shareId: 'ended-follow', peerId: 'old-peer', status: 'revoked' },
    ],
  )
  const old = new Map([
    ['bound', { shareId: 'old-share', peerId: 'bound-peer' }],
    ['viewer', { shareId: 'old-share', peerId: 'viewer-peer' }],
    ['follow', { shareId: 'old-share', peerId: 'follow-peer' }],
    ['anonymous-active', { shareId: 'active-share' }],
    ['inactive', { shareId: 'active-share', peerId: 'old-peer', endedAt: 9_999_999_999_999 }],
    ['anonymous-ended', { shareId: 'ended-share' }],
  ])
  const cleared = clearPeerHistory(old, protection)
  for (const key of ['bound', 'viewer', 'follow', 'anonymous-active'])
    assert.equal(cleared.get(key), old.get(key))
  for (const key of ['inactive', 'anonymous-ended']) assert.equal(cleared.get(key)?.cleared, true)
  assert.equal(Object.hasOwn(old.get('inactive')!, 'cleared'), false)
})

test('cleanup rollback restores old records without discarding notices received during persistence', () => {
  const before = new Map([['old', { shareId: 'old-share', peerId: 'old-peer', eventId: 'first' }]])
  const attempted = clearPeerHistory(before, { peerIds: [], shareIds: [] })
  const newNotice = { shareId: 'old-share', peerId: 'old-peer', eventId: 'second' }
  const current = new Map(attempted)
  current.set('old', newNotice)
  current.set('new', { shareId: 'new-share', peerId: 'new-peer', eventId: 'third' })
  const restored = restoreFailedPeerHistoryClear(current, before, attempted)
  assert.equal(restored.get('old'), newNotice)
  assert.equal(restored.get('new')?.eventId, 'third')
  assert.deepEqual(restoreFailedPeerHistoryClear(attempted, before, attempted), before)
})
