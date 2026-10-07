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
