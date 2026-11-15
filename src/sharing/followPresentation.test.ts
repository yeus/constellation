import assert from 'node:assert/strict'
import test from 'node:test'
import { followActivitySummary } from './followPresentation.ts'

const now = Date.parse('2026-11-12T21:35:00Z')

test('disconnected observations describe the age of the sender fix, not its receipt time', () => {
  assert.equal(
    followActivitySummary('unavailable', now - 2 * 60_000, now),
    'Not connected · Last location from 2 min ago',
  )
  assert.equal(
    followActivitySummary('unavailable', undefined, now),
    'Not connected · No location received',
  )
  assert.equal(
    followActivitySummary('delayed', now - 60_000, now),
    'Delayed · Last location from 1 min ago',
  )
})

test('active updates show the captured location age', () => {
  assert.equal(
    followActivitySummary('live', now - 2_000, now),
    'Live · Last location from less than a minute ago',
  )
})
