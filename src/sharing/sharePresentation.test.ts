import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeShareSummaries, hasNewShareRecipient } from './sharePresentation.ts'
import type { ShareSummary } from './sharingRuntime.ts'

test('background presence replaces duplicate foreground summaries without hiding distinct shares', () => {
  const share: ShareSummary = {
    shareId: 'synthetic-return-share',
    url: 'https://example.test/',
    precision: 'approximate',
    battery: 'balanced',
    network: 'always',
    expiresAt: null,
    viewerCount: 0,
  }
  const background = { ...share, viewerCount: 1, recipientPeerId: 'synthetic-original-peer' }
  assert.deepEqual(
    mergeShareSummaries([share, { ...share, shareId: 'synthetic-other' }], [background]),
    [background, { ...share, shareId: 'synthetic-other' }],
  )
})

test('QR dismissal follows a new approval request for its own link only', () => {
  const previous = { shares: [], pendingViewerApprovals: [] }
  const next = {
    shares: [],
    pendingViewerApprovals: [{ shareId: 'synthetic-link-a', peerId: 'synthetic-viewer' }],
  }
  assert.equal(hasNewShareRecipient('synthetic-link-a', previous, next), true)
  assert.equal(hasNewShareRecipient('synthetic-link-b', previous, next), false)
  assert.equal(hasNewShareRecipient('synthetic-link-a', next, next), false)
})

test('QR dismissal detects automatic admission and ignores routine presence updates', () => {
  const previous = { shares: [{ shareId: 'synthetic-link-a', viewerCount: 0 }] }
  const admitted = { shares: [{ shareId: 'synthetic-link-a', viewerCount: 1 }] }
  assert.equal(hasNewShareRecipient('synthetic-link-a', previous, admitted), true)
  assert.equal(hasNewShareRecipient('synthetic-link-b', previous, admitted), false)
  assert.equal(hasNewShareRecipient('synthetic-link-a', admitted, admitted), false)
  assert.equal(hasNewShareRecipient('synthetic-link-a', admitted, previous), false)
})

test('QR dismissal detects a new peer even when a polled viewer count stays the same', () => {
  const previous = {
    shares: [
      {
        shareId: 'synthetic-link',
        viewerCount: 1,
        viewers: [{ peerId: 'synthetic-old', fingerprint: 'synthetic-old', lastSeenAt: 1 }],
      },
    ],
  }
  const next = {
    shares: [
      {
        shareId: 'synthetic-link',
        viewerCount: 1,
        viewers: [{ peerId: 'synthetic-new', fingerprint: 'synthetic-new', lastSeenAt: 2 }],
      },
    ],
  }
  assert.equal(hasNewShareRecipient('synthetic-link', previous, next), true)
  assert.equal(
    hasNewShareRecipient('synthetic-link', next, {
      ...next,
      shares: [
        { ...next.shares[0]!, viewers: [{ ...next.shares[0]!.viewers[0]!, lastSeenAt: 3 }] },
      ],
    }),
    false,
  )
})
