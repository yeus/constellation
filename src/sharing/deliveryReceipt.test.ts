import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acknowledgeObservation,
  recordSentObservation,
  type DeliveryReceiptState,
} from './deliveryReceipt.ts'

const sent = (sequence: number, sourceId = 'synthetic-location-source') => ({
  sourceId,
  sequence,
  capturedAt: sequence * 1000,
})

test('only sent observations may be acknowledged', () => {
  const initial: DeliveryReceiptState = { pending: [], lastConfirmedAt: null }
  const recorded = recordSentObservation(initial, sent(8))
  assert.equal(acknowledgeObservation(recorded, sent(9), 12_000), recorded)
  assert.equal(acknowledgeObservation(recorded, sent(8, 'different-source'), 12_000), recorded)
  assert.equal(acknowledgeObservation(recorded, { ...sent(8), capturedAt: 2 }, 12_000), recorded)
  const confirmed = acknowledgeObservation(recorded, sent(8), 12_000)
  assert.deepEqual(confirmed, { pending: [], lastConfirmedAt: 12_000, lastConfirmed: sent(8) })
})

test('acknowledgements are monotonic and idempotent', () => {
  const initial: DeliveryReceiptState = { pending: [], lastConfirmedAt: null }
  const recorded = [1, 2, 3].reduce((state, n) => recordSentObservation(state, sent(n)), initial)
  const confirmed = acknowledgeObservation(recorded, sent(2), 5_000)
  assert.deepEqual(confirmed.pending, [sent(3)])
  assert.equal(acknowledgeObservation(confirmed, sent(1), 6_000), confirmed)
  assert.equal(acknowledgeObservation(confirmed, sent(2), 6_000), confirmed)
})

test('in-flight receipt tracking is bounded', () => {
  const initial: DeliveryReceiptState = { pending: [], lastConfirmedAt: null }
  const recorded = Array.from({ length: 50 }, (_, i) => i + 1).reduce(
    (state, n) => recordSentObservation(state, sent(n)),
    initial,
  )
  assert.equal(recorded.pending.length, 16)
  assert.equal(recorded.pending[0]?.sequence, 35)
  assert.equal(acknowledgeObservation(recorded, sent(1), 60_000), recorded)
})
