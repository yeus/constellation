import assert from 'node:assert/strict'
import test from 'node:test'

import {
  constellationProtocolV2,
  constellationProtocolV3,
  SHARE_STREAM_PROTOCOL,
  SHARE_STREAM_PROTOCOL_V3,
} from './shareProtocol.ts'

test('combines share authorization and Taskyon sensor operations on one versioned stream', () => {
  assert.equal(SHARE_STREAM_PROTOCOL, '/constellation/location-share/2.0.0')
  assert.equal(
    constellationProtocolV2.message.safeParse({
      type: 'share.redeemRequest',
      requestId: 'request-1',
      shareId: 'synthetic-share-id',
      viewerNonce: 'synthetic-viewer-nonce',
      proof: 'synthetic-proof-value-that-is-long-enough',
    }).success,
    true,
  )
  assert.equal(
    constellationProtocolV2.message.safeParse({
      type: 'sensor.subscribeRequest',
      requestId: 'request-2',
      sensorId: 'location',
    }).success,
    true,
  )
  assert.equal(
    constellationProtocolV2.message.safeParse({
      type: 'share.offerReturnRequest',
      requestId: 'request-3',
      sessionId: 'synthetic-session-id',
      url: 'https://example.invalid/#share=synthetic-return-capability',
      ownerPeerId: 'synthetic-owner-peer',
    }).success,
    true,
  )
  assert.equal(
    constellationProtocolV2.message.safeParse({ type: 'location.dumpAll' }).success,
    false,
  )
})

test('rejects unknown required semantics instead of silently accepting them', () => {
  assert.equal(
    constellationProtocolV2.message.safeParse({
      type: 'share.redeemRequest',
      requestId: 'request-unknown-field',
      shareId: 'synthetic-share-id',
      viewerNonce: 'synthetic-viewer-nonce',
      proof: 'synthetic-proof-value-that-is-long-enough',
      requiredFutureBehavior: true,
    }).success,
    false,
  )
  assert.equal(SHARE_STREAM_PROTOCOL, '/constellation/location-share/2.0.0')
})

test('redeeming an ended link returns a terminal reason without a live session', () => {
  assert.equal(
    constellationProtocolV2.message.safeParse({
      type: 'share.redeemResponse',
      requestId: 'ended-request',
      result: { ended: true, reason: 'revoked', endedAt: 1000 },
    }).success,
    true,
  )
})

test('single-recipient redemption can wait for approval or deny a different peer', () => {
  const response = constellationProtocolV2.message
  assert.equal(
    response.safeParse({
      type: 'share.redeemResponse',
      requestId: 'approval-pending',
      result: { approvalPending: true, retryAfterMs: 10_000 },
    }).success,
    true,
  )
  assert.equal(
    response.safeParse({
      type: 'share.redeemResponse',
      requestId: 'approval-denied',
      result: { accessDenied: true },
    }).success,
    true,
  )
})

test('offline stop notices do not require a location session or expose location access', () => {
  const parsed = constellationProtocolV2.message.safeParse({
    type: 'share.stopNoticeRequest',
    requestId: 'synthetic-stop-request',
    shareId: 'synthetic-share-id',
    eventId: 'synthetic-stop-event',
    proof: 'A'.repeat(43),
  })
  assert.equal(parsed.success, true)
  assert.equal(
    constellationProtocolV2.message.safeParse({
      type: 'share.stopNoticeRequest',
      requestId: 'synthetic-stop-request',
      shareId: 'synthetic-share-id',
      eventId: 'synthetic-stop-event',
      proof: 'A'.repeat(43),
      sessionId: 'unexpected-subscription',
    }).success,
    false,
  )
})

test('v3 acknowledges only an identified observation while leaving v2 unchanged', () => {
  assert.equal(SHARE_STREAM_PROTOCOL_V3, '/constellation/location-share/3.0.0')
  const request = {
    type: 'share.heartbeatRequest',
    requestId: 'heartbeat-1',
    sessionId: 'synthetic-session-id',
    receipt: { sourceId: 'synthetic-source', sequence: 17, capturedAt: 17000 },
  }
  assert.equal(constellationProtocolV3.message.safeParse(request).success, true)
  assert.equal(constellationProtocolV2.message.safeParse(request).success, false)
  assert.equal(
    constellationProtocolV3.message.safeParse({
      ...request,
      receipt: { sequence: 17, capturedAt: 17000 },
    }).success,
    false,
  )
  assert.equal(
    constellationProtocolV3.message.safeParse({
      ...request,
      receipt: { ...request.receipt, latitude: 4 },
    }).success,
    false,
  )
  assert.equal(
    constellationProtocolV3.message.safeParse({
      type: 'share.heartbeatRequest',
      requestId: 'heartbeat-old',
      sessionId: 'synthetic-session-id',
    }).success,
    true,
  )
})

test('v3 delivery receipt travels through the typed heartbeat RPC', async () => {
  const { createDuplexChannel, createPortClient, createPortServer } = await import(
    '@taskyon/protocol'
  )
  const channel = createDuplexChannel<ReturnType<typeof constellationProtocolV3.message.parse>>()
  const accepted: unknown[] = []
  const stop = createPortServer(channel.y, constellationProtocolV3, {
    share: {
      heartbeat: (request) => {
        accepted.push(request.receipt)
        return { receivedAt: 12345 }
      },
    },
  })
  try {
    const client = createPortClient(channel.x, constellationProtocolV3)
    const receipt = { sourceId: 'synthetic-location-source', sequence: 4, capturedAt: 4000 }
    const response = await client.share.heartbeat({ sessionId: 'synthetic-session-id', receipt })
    assert.deepEqual(response, { receivedAt: 12345 })
    assert.deepEqual(accepted, [receipt])
  } finally {
    stop()
  }
})
