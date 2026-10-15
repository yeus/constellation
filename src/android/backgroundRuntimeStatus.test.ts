import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundRuntimeStatus } from './backgroundRuntimeStatus.ts'
import type { SharingRuntimeState } from '../sharing/sharingRuntime.ts'

test('failed creation retains the revocation work and history that keep the service alive', () => {
  const state: SharingRuntimeState = {
    peerStatus: 'online',
    paused: false,
    location: { status: 'unavailable' },
    shares: [],
    received: [],
    following: [],
    returnOffers: [],
    approvedReturnLinks: ['synthetic-approved-link'],
    pendingViewerApprovals: [],
    oldSharing: [{ shareId: 'synthetic-ended-link', endedAt: 100, reason: 'revoked' }],
    oldSeeing: [],
    stoppedViewers: [],
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
  assert.equal(status.paused, false)
  assert.equal(status.endNotificationCount, 0)
  assert.deepEqual(status.shares, [])
})

test('projects a user pause while keeping every share and its grant', () => {
  const state: SharingRuntimeState = {
    peerStatus: 'online',
    paused: true,
    location: { status: 'unavailable' },
    shares: [
      {
        shareId: 'synthetic-paused-link',
        url: 'https://example.test/#share=synthetic-paused-link',
        precision: 'approximate',
        battery: 'balanced',
        network: 'always',
        paused: 'user',
        expiresAt: null,
        viewerCount: 1,
      },
    ],
    received: [],
    following: [],
    returnOffers: [],
    approvedReturnLinks: [],
    pendingViewerApprovals: [],
    oldSharing: [],
    oldSeeing: [],
    stoppedViewers: [],
    endNotifications: [],
    message: '',
    canSave: true,
  }
  const status = backgroundRuntimeStatus(
    state,
    {
      peerStatus: state.peerStatus,
      connections: [],
      sessionEvents: [],
    },
    state.location,
  )
  assert.equal(status.state, 'sharing')
  assert.equal(status.paused, true)
  assert.equal(status.shares[0]?.paused, 'user')
  assert.equal(status.shares[0]?.viewerCount, 1)
})
