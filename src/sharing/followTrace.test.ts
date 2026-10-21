import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFollowTrace, pruneFollowTrace, MAX_FOLLOW_TRACE_EVENTS } from './followTrace.ts'
import { LOCATION_PROFILE_V1 } from '../location/locationObservation.ts'

const observation = {
  profile: LOCATION_PROFILE_V1,
  sourceId: 'synthetic-source',
  precision: 'approximate' as const,
  sequence: 3,
  capturedAt: 100_000,
  expiresAt: 190_000,
  latitude: 32.7,
  longitude: -117.1,
  accuracyMeters: 1_000,
}

test('records only opted-in authenticated received events at the disclosed precision', () => {
  const next = appendFollowTrace(
    [],
    { type: 'location', observation, receivedAt: 125_000 },
    125_000,
  )
  assert.deepEqual(next, [
    {
      type: 'location',
      receivedAt: 125_000,
      capturedAt: 100_000,
      latitude: 32.7,
      longitude: -117.1,
      accuracyMeters: 1_000,
      precision: 'approximate',
      sequence: 3,
    },
  ])
  assert.equal(JSON.stringify(next).includes('synthetic-source'), false)
})

test('prunes events outside a rolling day, including future-dated entries', () => {
  const now = 90_000_000
  const input = [
    { type: 'closed' as const, receivedAt: now - 86_400_001, reason: 'revoked' as const },
    { type: 'closed' as const, receivedAt: now - 86_400_000, reason: 'expired' as const },
    { type: 'closed' as const, receivedAt: now + 1, reason: 'disconnected' as const },
  ]
  assert.deepEqual(pruneFollowTrace(input, now), [input[1]])
})

test('bounds sustained updates to the most recent events', () => {
  const events = Array.from({ length: MAX_FOLLOW_TRACE_EVENTS + 10 }, (_, i) => ({
    type: 'closed' as const,
    receivedAt: 1_000 + i,
    reason: 'error' as const,
  }))
  assert.equal(pruneFollowTrace(events, 10_000).length, MAX_FOLLOW_TRACE_EVENTS)
  assert.equal(pruneFollowTrace(events, 10_000)[0]?.receivedAt, 1_010)
})
