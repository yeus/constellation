import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundViewerSnapshot, viewerPrivateState } from './backgroundViewer.ts'
import type { PrivateState } from '../sharing/privateStore.ts'
import type { SharingRuntimeState } from '../sharing/sharingRuntime.ts'

test('background viewer isolates saved subscriptions from outgoing source and UI state', () => {
  const stored: PrivateState = {
    version: 1,
    privateKey: 'synthetic-private-key',
    shares: [
      {
        url: 'https://example.invalid/#share=outgoing-secret',
        publication: 'background',
        precision: 'exact',
        capacity: 1,
      },
    ],
    endedShares: [
      {
        url: 'https://example.invalid/#share=ended-secret',
        publication: 'background',
        reason: 'revoked',
        endedAt: 1,
      },
    ],
    followed: [
      {
        url: 'https://example.invalid/#share=incoming-secret',
        localName: 'Test location',
        color: '#445566',
      },
    ],
    pendingReturns: [{ shareId: 'incoming', url: 'https://example.invalid/#share=return' }],
    pendingStopNotices: [],
    oldSeeing: [],
    oldSharing: [{ shareId: 'outgoing', reason: 'revoked', endedAt: 1 }],
    sharingBehavior: { publication: 'background', battery: 'balanced', network: 'always' },
    mapCamera: undefined,
  }
  const viewer = viewerPrivateState(stored)
  assert.deepEqual(viewer, {
    version: stored.version,
    privateKey: stored.privateKey,
    shares: [],
    followed: stored.followed,
    pendingReturns: stored.pendingReturns,
    pendingStopNotices: [],
    oldSeeing: [],
  })
  assert.equal(JSON.stringify(viewer).includes('outgoing-secret'), false)
  assert.equal(JSON.stringify(viewer).includes('ended-secret'), false)
})

test('background receiver retains opted-in recorded events for the on-screen inspector', () => {
  const now = Date.now()
  const event = {
    type: 'location' as const,
    receivedAt: now,
    capturedAt: now - 1_000,
    latitude: 32.71,
    longitude: -117.16,
    accuracyMeters: 1_000,
    precision: 'approximate' as const,
    sequence: 21,
  }
  const snapshot = backgroundViewerSnapshot(4, {
    following: [
      {
        shareId: 'saved',
        saved: true,
        connected: true,
        status: 'live',
        updatesReceived: 21,
        traceEnabled: true,
        trace: [event],
      },
      {
        shareId: 'not-recording',
        saved: true,
        connected: true,
        status: 'live',
        updatesReceived: 15,
        traceEnabled: false,
        trace: [event],
      },
    ],
    received: [],
  } as unknown as SharingRuntimeState)
  assert.deepEqual(snapshot.following[0]?.trace, [event])
  assert.equal(snapshot.following[0]?.traceEnabled, true)
  assert.equal(snapshot.following[1]?.trace, undefined)
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE-URL'), false)
})

test('background viewer projection exposes only saved authorized observations, no bearer URLs', () => {
  const state = {
    following: [
      {
        shareId: 'saved',
        saved: true,
        status: 'stale',
        connected: false,
        updatesReceived: 8,
        url: 'PRIVATE-URL',
      },
      {
        shareId: 'preview',
        saved: false,
        status: 'live',
        connected: true,
        updatesReceived: 1,
        url: 'OTHER-URL',
      },
      {
        shareId: 'revoked',
        saved: true,
        status: 'revoked',
        connected: false,
        updatesReceived: 5,
        url: 'REVOKED-URL',
      },
    ],
    received: [
      { shareId: 'saved', observation: { sequence: 1 }, state: 'stale' },
      { shareId: 'preview', observation: { sequence: 2 }, state: 'live' },
      { shareId: 'revoked', observation: { sequence: 3 }, state: 'stale' },
    ],
  } as unknown as SharingRuntimeState
  const result = backgroundViewerSnapshot(7, state)
  assert.deepEqual(result.following, [
    {
      shareId: 'saved',
      status: 'stale',
      connected: false,
      updatesReceived: 8,
    },
  ])
  assert.deepEqual(
    result.received.map(({ shareId }) => shareId),
    ['saved'],
  )
  assert.equal(JSON.stringify(result).includes('PRIVATE-URL'), false)
  assert.equal(JSON.stringify(result).includes('OTHER-URL'), false)
  assert.equal(JSON.stringify(result).includes('REVOKED-URL'), false)
})
