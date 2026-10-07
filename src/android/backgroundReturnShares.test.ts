import assert from 'node:assert/strict'
import test from 'node:test'

import { receiveApprovedBackgroundReturns } from './backgroundReturnShares.ts'

const offer = (shareId: string, viewerFingerprint: string) => ({
  shareId,
  viewerFingerprint,
  ownerPeerId: `synthetic-${viewerFingerprint}`,
  url: 'https://example.invalid/#share=synthetic-return',
})

test('all approved link-group returns reach the foreground receiver and are acknowledged afterward', async () => {
  const events: string[] = []
  const result = await receiveApprovedBackgroundReturns(
    {
      approvedReturnLinks: ['approved'],
      returnOffers: [
        offer('unapproved', 'first'),
        offer('approved', 'second'),
        offer('approved', 'third'),
      ],
    },
    async ({ viewerFingerprint }) => {
      events.push(`receive:${viewerFingerprint}`)
    },
    async ({ viewerFingerprint }) => {
      events.push(`acknowledge:${viewerFingerprint}`)
    },
  )
  assert.deepEqual(events, [
    'receive:second',
    'acknowledge:second',
    'receive:third',
    'acknowledge:third',
  ])
  assert.deepEqual(result, { accepted: 2, failed: 0 })
})

test('failed receive or acknowledgement leaves the native offer queued and does not block other peers', async () => {
  const acknowledged: string[] = []
  const result = await receiveApprovedBackgroundReturns(
    {
      approvedReturnLinks: ['approved'],
      returnOffers: [
        offer('approved', 'receive-fails'),
        offer('approved', 'ack-fails'),
        offer('approved', 'works'),
      ],
    },
    async ({ viewerFingerprint }) => {
      if (viewerFingerprint === 'receive-fails') throw new Error('Synthetic receiving failure')
    },
    async ({ viewerFingerprint }) => {
      if (viewerFingerprint === 'ack-fails') throw new Error('Synthetic persistence failure')
      acknowledged.push(viewerFingerprint)
    },
  )
  assert.deepEqual(acknowledged, ['works'])
  assert.deepEqual(result, { accepted: 1, failed: 2 })
})
