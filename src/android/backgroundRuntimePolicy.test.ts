import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasStalledDelivery,
  shouldAttemptTransportRecovery,
  shouldSignalIdleAfterShareUpdate,
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
