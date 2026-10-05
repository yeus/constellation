import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundRuntimeStatus } from './backgroundRuntimeStatus.ts'
import type { SharingRuntimeState } from '../sharing/sharingRuntime.ts'

test('failed creation retains the revocation work and history that keep the service alive', () => {
  const state: SharingRuntimeState = {
    peerStatus: 'online',
    location: { status: 'unavailable' },
    shares: [],
    received: [],
    following: [],
    returnOffers: [],
    approvedReturnLinks: ['synthetic-approved-link'],
    oldSharing: [{ shareId: 'synthetic-ended-link', endedAt: 100, reason: 'revoked' }],
    oldSeeing: [],
    endNotifications: [
      { shareId: 'synthetic-ended-link', publication: 'background', retainUntil: 200 },
    ],
    message: '',
    canSave: true,
  }
  const diagnostics = { peerStatus: state.peerStatus, connections: [], sessionEvents: [] }
  const status = backgroundRuntimeStatus(
    state,
    diagnostics,
    state.location,
    'Synthetic create failure',
  )
  assert.equal(status.state, 'error')
  assert.equal(status.message, 'Synthetic create failure')
  assert.equal(status.endNotificationCount, 1)
  assert.deepEqual(status.oldSharing, state.oldSharing)
  assert.deepEqual(status.approvedReturnLinks, state.approvedReturnLinks)
  assert.deepEqual(status.shares, [])
  assert.equal(backgroundRuntimeStatus(state, diagnostics, state.location).state, 'stopped')
})

test('failure before runtime initialization has a valid idle error status', () => {
  const status = backgroundRuntimeStatus(
    undefined,
    { peerStatus: 'offline', connections: [], sessionEvents: [] },
    { status: 'unavailable' },
    'Synthetic restore failure',
  )
  assert.equal(status.state, 'error')
  assert.equal(status.endNotificationCount, 0)
  assert.deepEqual(status.shares, [])
})
