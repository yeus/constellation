import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFollowOwnerState } from './followOwnerProjection.ts'
import type { FollowSummary } from '../sharing/sharingContracts.ts'
import type { BackgroundViewerSnapshot } from './backgroundViewer.ts'

const event = (receivedAt: number) => ({
  type: 'location' as const,
  receivedAt,
  capturedAt: receivedAt - 1000,
  latitude: 33.1,
  longitude: -117.2,
  accuracyMeters: 40,
  precision: 'approximate' as const,
  sequence: 3,
})
const activity: FollowSummary = {
  shareId: 'saved',
  displayName: 'Peer',
  localName: 'Peer',
  color: '#438ec9',
  connected: false,
  status: 'unavailable',
  saved: true,
  updatesReceived: 0,
  traceEnabled: true,
  trace: [],
  expiresAt: null,
  returnPromptSeen: true,
}

test('immediately displays persisted background receiver history, not stale Activity counters', () => {
  const receivedAt = Date.now()
  const receiver: BackgroundViewerSnapshot = {
    generation: 4,
    following: [
      {
        shareId: 'saved',
        status: 'live',
        connected: true,
        updatesReceived: 7,
        traceEnabled: true,
        trace: [event(receivedAt)],
      },
    ],
    received: [
      {
        shareId: 'saved',
        state: 'live',
        observation: {
          profile: 'dev.constellation.location/v1',
          sourceId: 'source',
          sequence: 3,
          capturedAt: receivedAt - 1000,
          expiresAt: receivedAt + 60_000,
          latitude: 33.1,
          longitude: -117.2,
          accuracyMeters: 40,
          precision: 'approximate',
        },
      },
    ],
  }
  const [projected] = projectFollowOwnerState([activity], 'service', receiver)
  assert.equal(projected?.status, 'live')
  assert.equal(projected?.lastLocationAt, receivedAt - 1000)
  assert.equal(projected?.updatesReceived, 7)
  assert.deepEqual(projected?.trace, [event(receivedAt)])
  assert.equal(projected?.receiverStatusPending, false)
  assert.deepEqual(activity.trace, [])
})

test('missing service snapshot shows a pending state instead of reporting zero history', () => {
  const [projected] = projectFollowOwnerState(
    [{ ...activity, lastLocationAt: 1234, updatesReceived: 10, trace: [event(Date.now())] }],
    'service',
    undefined,
  )
  assert.equal(projected?.receiverStatusPending, true)
  assert.equal(projected?.lastLocationAt, undefined)
  assert.equal(projected?.trace, undefined)
  assert.equal(projected?.status, 'unavailable')
})

test('background opt-out never resurrects old Activity recordings', () => {
  const [projected] = projectFollowOwnerState(
    [{ ...activity, trace: [event(Date.now())] }],
    'service',
    {
      generation: 4,
      following: [
        {
          shareId: 'saved',
          status: 'stale',
          connected: false,
          updatesReceived: 3,
          traceEnabled: false,
        },
      ],
      received: [],
    },
  )
  assert.equal(projected?.traceEnabled, false)
  assert.equal(projected?.trace, undefined)
  assert.equal(projected?.receiverStatusPending, false)
  assert.equal(projectFollowOwnerState([activity], 'activity', undefined)[0], activity)
})
test('restored receiver history supplies the last known fix even before a live update', () => {
  const recorded = event(Date.now() - 2_000)
  const [projected] = projectFollowOwnerState([activity], 'service', {
    generation: 7,
    following: [
      {
        shareId: 'saved',
        status: 'unavailable',
        connected: false,
        updatesReceived: 0,
        traceEnabled: true,
        trace: [recorded],
      },
    ],
    received: [],
  })
  assert.equal(projected?.status, 'unavailable')
  assert.equal(projected?.lastLocationAt, recorded.capturedAt)
  assert.deepEqual(projected?.trace, [recorded])
})
