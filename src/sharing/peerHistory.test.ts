import assert from 'node:assert/strict'
import test from 'node:test'
import {
  protectActivePeerHistory,
  clearPeerHistory,
  restoreFailedPeerHistoryClear,
  canRecordLocalStop,
  hasEndedPeerShare,
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

test('local stop history does not blacklist a share, while revocation still does', () => {
  const shareId = 'synthetic-share-id'
  const local = [{ shareId, reason: 'stopped' as const }]
  assert.equal(hasEndedPeerShare(local, shareId), false)
  assert.equal(
    hasEndedPeerShare([...local, { shareId, reason: 'revoked' as const }], shareId),
    true,
  )
  assert.equal(hasEndedPeerShare([{ shareId, reason: 'expired' as const }], shareId), true)
})

test('simultaneous sender end retains terminal evidence over local stopped history', () => {
  const shareId = 'synthetic-share-id'
  assert.equal(canRecordLocalStop([], shareId), true)
  assert.equal(canRecordLocalStop([], shareId, 'revoked'), false)
  assert.equal(canRecordLocalStop([], shareId, 'expired'), false)
  assert.equal(canRecordLocalStop([{ shareId, reason: 'revoked' }], shareId), false)
  assert.equal(canRecordLocalStop([{ shareId, reason: 'stopped' }], shareId), true)
})
