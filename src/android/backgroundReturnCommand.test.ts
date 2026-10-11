import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBackgroundReturnCommand } from './backgroundReturnCommand.ts'

test('return approval is acknowledged only after persistence finishes', async () => {
  let finish!: () => void
  const persistence = new Promise<void>((resolve) => {
    finish = resolve
  })
  const results: unknown[] = []
  const running = executeBackgroundReturnCommand(
    {
      approveReturnLink: () => persistence,
      dismissReturnOffer: async () => undefined,
      dismissStoppedViewer: async () => undefined,
    },
    {
      type: 'approve-return-link',
      requestId: 'synthetic-request',
      shareId: 'synthetic-share',
    },
    (result) => results.push(result),
  )
  assert.deepEqual(results, [])
  finish()
  await running
  assert.deepEqual(results, [{ type: 'command-complete', requestId: 'synthetic-request' }])
})

test('failed return approval is acknowledged as a failure', async () => {
  const results: unknown[] = []
  await executeBackgroundReturnCommand(
    {
      approveReturnLink: async () => {
        throw new Error('Synthetic private storage failure')
      },
      dismissReturnOffer: async () => undefined,
      dismissStoppedViewer: async () => undefined,
    },
    {
      type: 'approve-return-link',
      requestId: 'synthetic-request',
      shareId: 'synthetic-share',
    },
    (result) => results.push(result),
  )
  assert.deepEqual(results, [
    {
      type: 'command-complete',
      requestId: 'synthetic-request',
      error: 'Could not save the return-sharing change.',
    },
  ])
})

test('failed dismissal remains a correlated failure instead of hiding the offer', async () => {
  const results: unknown[] = []
  await executeBackgroundReturnCommand(
    {
      approveReturnLink: async () => undefined,
      dismissReturnOffer: async () => {
        throw new Error('Synthetic private storage failure')
      },
      dismissStoppedViewer: async () => undefined,
    },
    {
      type: 'dismiss-return-offer',
      requestId: 'synthetic-dismissal',
      shareId: 'synthetic-share',
      fingerprint: 'synthetic-viewer',
    },
    (result) => results.push(result),
  )
  assert.deepEqual(results, [
    {
      type: 'command-complete',
      requestId: 'synthetic-dismissal',
      error: 'Could not save the return-sharing change.',
    },
  ])
})

test('dismissal of a stopped-viewer notice remains correlated to protected persistence', async () => {
  const results: unknown[] = []
  const calls: string[] = []
  await executeBackgroundReturnCommand(
    {
      approveReturnLink: async () => undefined,
      dismissReturnOffer: async () => undefined,
      dismissStoppedViewer: async (shareId, peerId) => {
        calls.push(`${shareId}:${peerId}`)
      },
    },
    {
      type: 'dismiss-stopped-viewer',
      requestId: 'synthetic-stop-dismiss',
      shareId: 'synthetic-share',
      peerId: 'synthetic-peer',
    },
    (result) => results.push(result),
  )
  assert.deepEqual(calls, ['synthetic-share:synthetic-peer'])
  assert.deepEqual(results, [{ type: 'command-complete', requestId: 'synthetic-stop-dismiss' }])
})
