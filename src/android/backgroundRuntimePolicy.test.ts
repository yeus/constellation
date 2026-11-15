import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasStalledDelivery,
  hasRecentAuthenticatedViewer,
  shouldAttemptTransportRecovery,
  shouldAttemptReceiverRecovery,
  shouldSignalIdleAfterShareUpdate,
  receiverRecoveryOutcome,
} from './backgroundRuntimePolicy.ts'

test('signals service idle only when the final active share disappears', () => {
  assert.equal(shouldSignalIdleAfterShareUpdate(0, 0), false)
  assert.equal(shouldSignalIdleAfterShareUpdate(0, 1), false)
  assert.equal(shouldSignalIdleAfterShareUpdate(2, 1), false)
  assert.equal(shouldSignalIdleAfterShareUpdate(1, 0), true)
})

test('recovery follows a network transition without restarting on every callback', () => {
  const ready = { online: true, backgroundSources: 1, now: 90_000, lastRecoveryAt: null }
  assert.equal(shouldAttemptTransportRecovery(ready), true)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, online: false }), false)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, backgroundSources: 0 }), false)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, lastRecoveryAt: 82_000 }), false)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, lastRecoveryAt: 60_000 }), true)
})

test('a healthy authenticated viewer prevents a destructive network-handoff restart', () => {
  const now = 100_000
  const share = {
    publication: 'background' as const,
    viewers: [{ lastSeenAt: now - 10_000 }],
  }
  assert.equal(hasRecentAuthenticatedViewer([share], now), true)
  assert.equal(
    hasRecentAuthenticatedViewer([{ ...share, viewers: [{ lastSeenAt: now - 60_000 }] }], now),
    false,
  )
  assert.equal(hasRecentAuthenticatedViewer([{ ...share, viewers: [] }], now), false)
  assert.equal(hasRecentAuthenticatedViewer([{ ...share, publication: 'foreground' }], now), false)
  const ready = {
    online: true,
    backgroundSources: 1,
    now,
    lastRecoveryAt: null,
    recentlyActive: true,
  }
  assert.equal(shouldAttemptTransportRecovery(ready), false)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, stalled: true }), true)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, recentlyActive: false }), true)
})

test('missing receiver receipts detect stalled delivery without relying on fresh GPS fixes', () => {
  const viewer = {
    deliveryVerification: 'supported' as const,
    pendingObservations: 2,
    pendingSince: 1_000,
    lastSubmittedAt: 100_000,
  }
  const share = { publication: 'background' as const, viewers: [viewer] }
  assert.equal(hasStalledDelivery([share], 100_000), true)
  assert.equal(hasStalledDelivery([share], 80_000), false)
  assert.equal(
    hasStalledDelivery([{ ...share, viewers: [{ ...viewer, pendingSince: 90_000 }] }], 100_000),
    false,
  )
  assert.equal(
    hasStalledDelivery([{ ...share, viewers: [{ ...viewer, pendingObservations: 0 }] }], 100_000),
    false,
  )
  assert.equal(
    hasStalledDelivery(
      [{ ...share, viewers: [{ ...viewer, deliveryVerification: 'unsupported' as const }] }],
      100_000,
    ),
    false,
  )
  assert.equal(
    hasStalledDelivery([{ ...share, publication: 'foreground' as const }], 100_000),
    false,
  )
})

test('stalled-delivery watchdog uses a five-minute retry floor', () => {
  const ready = {
    online: true,
    backgroundSources: 1,
    now: 600_000,
    lastRecoveryAt: 400_000,
    stalled: true,
  }
  assert.equal(shouldAttemptTransportRecovery(ready), false)
  assert.equal(shouldAttemptTransportRecovery({ ...ready, lastRecoveryAt: 200_000 }), true)
})

test('receiver reconnection is only confirmed once every saved follow is actually connected', () => {
  assert.equal(receiverRecoveryOutcome([{ connected: true }]), 'connected')
  assert.equal(receiverRecoveryOutcome([{ connected: true }, { connected: false }]), 'pending')
  assert.equal(receiverRecoveryOutcome([{ connected: false }]), 'pending')
  assert.equal(receiverRecoveryOutcome([]), 'pending')
})

test('background receiver reconnects on handoff or disconnection but rate-limits retries', () => {
  const state = {
    online: true,
    savedFollows: 2,
    disconnected: true,
    now: 300_000,
    lastRecoveryAt: null,
    force: false,
  }
  assert.equal(shouldAttemptReceiverRecovery(state), true)
  assert.equal(shouldAttemptReceiverRecovery({ ...state, online: false }), false)
  assert.equal(shouldAttemptReceiverRecovery({ ...state, savedFollows: 0 }), false)
  assert.equal(shouldAttemptReceiverRecovery({ ...state, disconnected: false }), false)
  assert.equal(shouldAttemptReceiverRecovery({ ...state, disconnected: false, force: true }), true)
  assert.equal(shouldAttemptReceiverRecovery({ ...state, lastRecoveryAt: 240_000 }), false)
  assert.equal(shouldAttemptReceiverRecovery({ ...state, lastRecoveryAt: 100_000 }), true)
})
