import assert from 'node:assert/strict'
import test from 'node:test'

import { constellationProtocolV1, SHARE_STREAM_PROTOCOL } from './shareProtocol.ts'

test('combines share authorization and Taskyon sensor operations on one versioned stream', () => {
  assert.equal(SHARE_STREAM_PROTOCOL, '/constellation/location-share/1.0.0')
  assert.equal(
    constellationProtocolV1.message.safeParse({
      type: 'share.redeemRequest',
      requestId: 'request-1',
      shareId: 'synthetic-share-id',
      viewerNonce: 'synthetic-viewer-nonce',
      proof: 'synthetic-proof-value-that-is-long-enough',
    }).success,
    true,
  )
  assert.equal(
    constellationProtocolV1.message.safeParse({
      type: 'sensor.subscribeRequest',
      requestId: 'request-2',
      sensorId: 'location',
    }).success,
    true,
  )
  assert.equal(
    constellationProtocolV1.message.safeParse({
      type: 'share.offerReturnRequest',
      requestId: 'request-3',
      sessionId: 'synthetic-session-id',
      url: 'https://example.invalid/#share=synthetic-return-capability',
    }).success,
    true,
  )
  assert.equal(
    constellationProtocolV1.message.safeParse({ type: 'location.dumpAll' }).success,
    false,
  )
})
