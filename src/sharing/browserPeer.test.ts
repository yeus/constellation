import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import type { Connection, Stream } from '@libp2p/interface'

import {
  dialShareStream,
  orderShareAddresses,
  reachableRelayAddresses,
  requireReachablePeer,
} from './browserPeer.ts'

test('finds a reserved relay address using the connected address form', () => {
  const connected = '/ip4/192.0.2.10/tcp/443/wss/p2p/relay'
  const circuit = `${connected}/p2p-circuit/p2p/source`

  assert.deepEqual(reachableRelayAddresses([circuit], connected), [circuit])
  assert.deepEqual(reachableRelayAddresses([circuit], '/dns4/relay.invalid/tcp/443/wss'), [])
})

test('prefers direct addresses then plain circuit relay before WebRTC-over-relay', () => {
  const webRtc = '/dns4/relay.invalid/tcp/443/wss/p2p-circuit/webrtc'
  const circuit = '/dns4/relay.invalid/tcp/443/wss/p2p-circuit'
  const direct = '/ip4/192.0.2.10/tcp/443/wss/p2p/source'

  assert.deepEqual(orderShareAddresses([webRtc, circuit, direct]), [direct, circuit, webRtc])
})

test('share streams may run over limited relay connections', async () => {
  const expectedError = new Error('dial stopped after options were captured')
  let receivedOptions: unknown
  const node = {
    dialProtocol: async (_peer, _protocol, options) => {
      receivedOptions = options
      throw expectedError
    },
  } satisfies Pick<BrowserLibp2pNode, 'dialProtocol'>

  await assert.rejects(
    dialShareStream(node, ['/ip4/127.0.0.1/tcp/1'], '/constellation/test/1.0.0'),
    expectedError,
  )
  assert.deepEqual(receivedOptions, { runOnLimitedConnection: true })
})

test('prefers an existing authenticated peer connection before advertised relay addresses', async () => {
  const stream = {} as Stream
  const targets: unknown[] = []
  const relayConnection = {
    direct: false,
    newStream: async () => {
      targets.push('relay connection')
      return stream
    },
  } as unknown as Connection
  const directConnection = {
    direct: true,
    newStream: async () => {
      targets.push('direct connection')
      return stream
    },
  } as unknown as Connection
  const node = {
    dialProtocol: async (target: unknown) => {
      targets.push(target)
      return stream
    },
  } as Pick<BrowserLibp2pNode, 'dialProtocol'>

  assert.equal(
    await dialShareStream(
      node,
      ['/ip4/127.0.0.1/tcp/1/p2p-circuit/p2p/synthetic-connected-peer'],
      '/constellation/test/1.0.0',
      [relayConnection, directConnection],
    ),
    stream,
  )
  assert.deepEqual(targets, ['direct connection'])
})

test('stops an unreachable peer so a later attempt can start cleanly', async () => {
  let stopped = false
  const node = {
    stop: async () => {
      stopped = true
    },
  }

  await assert.rejects(requireReachablePeer(node, []), /No reachable P2P address is available/)
  assert.equal(stopped, true)
})

test('keeps a reachable peer running', async () => {
  let stopped = false
  const node = {
    stop: async () => {
      stopped = true
    },
  }

  assert.deepEqual(await requireReachablePeer(node, ['/dns4/relay.invalid/p2p/peer']), [
    '/dns4/relay.invalid/p2p/peer',
  ])
  assert.equal(stopped, false)
})
