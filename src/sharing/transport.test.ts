import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTransport } from './transport.ts'

test('classifies direct transports separately from relay circuits', () => {
  const fixtures: Array<[string, ReturnType<typeof classifyTransport>]> = [
    ['/ip4/192.0.2.10/tcp/4001/ws/p2p/12D3KooWSyntheticPeer', 'WebSocket'],
    ['/dns4/share.example/tcp/443/wss/p2p/12D3KooWSyntheticPeer', 'WebSocket'],
    ['/ip4/192.0.2.10/udp/4001/webrtc-direct/certhash/uEiSynthetic', 'WebRTC'],
    ['/webrtc/p2p/12D3KooWSyntheticPeer', 'WebRTC'],
    ['/ip4/192.0.2.10/udp/4001/quic-v1/webtransport/certhash/uEiSynthetic', 'WebTransport'],
    ['/ip4/192.0.2.10/tcp/4001/p2p/12D3KooWSyntheticPeer', 'other'],
  ]

  for (const [address, expected] of fixtures) {
    assert.equal(classifyTransport(address), expected, address)
  }
})

test('classifies relay circuits and relay-signalled WebRTC distinctly', () => {
  const relay = '/ip4/192.0.2.20/tcp/443/wss/p2p/12D3KooWSyntheticRelay'
  const source = '12D3KooWSyntheticSource'

  assert.equal(classifyTransport(`${relay}/p2p-circuit/p2p/${source}`), 'relay circuit')
  assert.equal(classifyTransport(`${relay}/p2p-circuit/webrtc/p2p/${source}`), 'WebRTC over relay')
  assert.equal(classifyTransport(relay), 'WebSocket')
})

test('keeps the direct WebRTC data connection distinct from its relay signalling entry', () => {
  const source = '12D3KooWSyntheticSource'
  const established = '/webrtc/p2p/12D3KooWSyntheticViewer'
  const signalling = `/ip4/192.0.2.20/tcp/9111/ws/p2p/12D3KooWSyntheticRelay/p2p-circuit/webrtc/p2p/${source}`

  assert.equal(classifyTransport(established), 'WebRTC')
  assert.equal(classifyTransport(signalling), 'WebRTC over relay')
  assert.notEqual(classifyTransport(signalling), 'relay circuit')
})
