import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundViewerSnapshot, viewerPrivateState } from './backgroundViewer.ts'
import type { PrivateState } from '../sharing/privateStore.ts'
import type { SharingRuntimeState } from '../sharing/sharingRuntime.ts'

test('background viewer cannot adopt local outgoing source keys', () => {
  const empty: PrivateState = {
    version: 1,
    privateKey: 'synthetic-secret',
    shares: [],
    followed: [],
  }
  assert.deepEqual(viewerPrivateState(empty), empty)
  assert.throws(
    () =>
      viewerPrivateState({
        ...empty,
        shares: [
          {
            url: 'https://example.invalid/#share=synthetic',
            publication: 'background',
            precision: 'exact',
            capacity: 1,
          },
        ],
      }),
    /separate source-share/,
  )
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
