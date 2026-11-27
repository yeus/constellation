import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import type { Connection, Stream } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

import {
  dialShareStream,
  orderShareAddresses,
  offlineShareAddresses,
  reachableRelayAddresses,
  retryUnreachablePeerStart,
  UnreachablePeerError,
  requireReachablePeer,
} from './browserPeer.ts'

test('offline invitations predict circuit addresses without a live reservation', () => {
  const relay = '/dns4/relay.example/tcp/443/wss/p2p/relay-identity'
  const expected = `${relay}/p2p-circuit/p2p/source-identity`
  assert.deepEqual(offlineShareAddresses('source-identity', [relay]), [expected])
  assert.deepEqual(offlineShareAddresses('source-identity', [relay, relay + '/p2p-circuit']), [
    expected,
  ])
  assert.deepEqual(offlineShareAddresses('source-identity', ['/ip4/127.0.0.1/tcp/9111/ws']), [
    '/ip4/127.0.0.1/tcp/9111/ws',
  ])
})

test('resolves offline relay hints to authenticated source circuits at dial time', async () => {
  const source = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const relay = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const hint = '/ip4/127.0.0.1/tcp/9111/ws'
  const connected = `${hint}/p2p/${relay}`
  const target = `${connected}/p2p-circuit/p2p/${source}`
  const stream = {} as Stream
  let address = ''
  const node = {
    dial: async () => ({
      remoteAddr: { toString: () => connected },
      remotePeer: { toString: () => relay },
    }),
    dialProtocol: async (remote: { toString: () => string }) => {
      address = remote.toString()
      return stream
    },
  } as unknown as BrowserLibp2pNode
  assert.equal(
    await dialShareStream(node, [hint], '/constellation/test/1.0.0', [], undefined, 5_000, source),
    stream,
  )
  assert.equal(address, target)
})

test('finds a reserved relay address using the connected address form', () => {
  const connected = '/ip4/192.0.2.10/tcp/443/wss/p2p/relay'
  const circuit = `${connected}/p2p-circuit/p2p/source`

  assert.deepEqual(reachableRelayAddresses([circuit], connected), [circuit])
  assert.deepEqual(reachableRelayAddresses([circuit], '/dns4/relay.invalid/tcp/443/wss'), [])
})

test('retains WebRTC signaling addresses from the reserved relay', () => {
  const connected = '/ip4/192.0.2.10/tcp/443/wss/p2p/relay'
  const circuit = `${connected}/p2p-circuit/p2p/source`
  const webRtc = `${connected}/p2p-circuit/webrtc/p2p/source`
  const unrelated = '/ip4/192.0.2.11/tcp/443/wss/p2p/other/p2p-circuit/webrtc/p2p/source'
  const nested = `${connected}/p2p-circuit/p2p-circuit/webrtc/p2p/source`
  assert.deepEqual(reachableRelayAddresses([circuit, webRtc, unrelated, nested], connected), [
    circuit,
    webRtc,
  ])
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

test('a stalled comparison stream dial can be cancelled on both connected and relay paths', async () => {
  const controller = new AbortController()
  const observed: AbortSignal[] = []
  const connection = {
    direct: true,
    newStream: async (_protocol: unknown, options: { signal?: AbortSignal }) => {
      if (options.signal) observed.push(options.signal)
      throw new Error('Existing connection no longer usable')
    },
  } as unknown as Connection
  const node = {
    dialProtocol: async (_peer: unknown, _protocol: unknown, options: { signal?: AbortSignal }) => {
      if (options.signal) observed.push(options.signal)
      return new Promise<Stream>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('dial cancelled'))
          return
        }
        options.signal?.addEventListener('abort', () => reject(new Error('dial cancelled')), {
          once: true,
        })
      })
    },
  } as Pick<BrowserLibp2pNode, 'dialProtocol'>
  const dial = dialShareStream(
    node,
    ['/ip4/127.0.0.1/tcp/1'],
    '/constellation/device-comparison/1.0.0',
    [connection],
    controller.signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(dial, /cancelled/)
  assert.deepEqual(observed, [controller.signal, controller.signal])
})

test('comparison dial leaves a stalled connection to try an advertised address before its total deadline', async () => {
  const controller = new AbortController()
  const stream = {} as Stream
  const attempts: string[] = []
  const stalled = {
    direct: true,
    newStream: async (_protocol: unknown, options: { signal?: AbortSignal }) =>
      new Promise<Stream>((_resolve, reject) => {
        attempts.push('stalled-connection')
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('stalled dial cancelled')),
          {
            once: true,
          },
        )
      }),
  } as unknown as Connection
  const node = {
    dialProtocol: async (_peer: unknown, _protocol: unknown, options: { signal?: AbortSignal }) => {
      attempts.push('advertised-address')
      if (options.signal?.aborted) throw new Error('overall deadline exhausted')
      return stream
    },
  } as Pick<BrowserLibp2pNode, 'dialProtocol'>
  const overallTimer = setTimeout(() => controller.abort(), 300)
  try {
    assert.equal(
      await dialShareStream(
        node,
        ['/ip4/127.0.0.1/tcp/1'],
        '/constellation/device-comparison/1.0.0',
        [stalled],
        controller.signal,
        25,
      ),
      stream,
    )
    assert.deepEqual(attempts, ['stalled-connection', 'advertised-address'])
    assert.equal(controller.signal.aborted, false)
  } finally {
    clearTimeout(overallTimer)
  }
})

test('cancelling a comparison dial prevents any fallback address from opening', async () => {
  const controller = new AbortController()
  const attempted: string[] = []
  const connection = {
    direct: true,
    newStream: async () => {
      attempted.push('connected-path')
      controller.abort()
      throw new Error('viewer cancelled comparison')
    },
  } as unknown as Connection
  const node = {
    dialProtocol: async () => {
      attempted.push('advertised-path')
      return {} as Stream
    },
  } as Pick<BrowserLibp2pNode, 'dialProtocol'>
  await assert.rejects(
    dialShareStream(
      node,
      ['/ip4/127.0.0.1/tcp/1'],
      '/constellation/device-comparison/1.0.0',
      [connection],
      controller.signal,
      25,
    ),
    /viewer cancelled comparison/,
  )
  assert.deepEqual(attempted, ['connected-path'])
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

test('restarts an unreachable private peer once with the same caller input', async () => {
  let attempts = 0
  const result = await retryUnreachablePeerStart(async () => {
    attempts += 1
    if (attempts === 1) throw new UnreachablePeerError()
    return { authenticatedPeer: true }
  })
  assert.deepEqual(result, { authenticatedPeer: true })
  assert.equal(attempts, 2)
})

test('does not retry unrelated failures or retry an unreachable peer indefinitely', async () => {
  let attempts = 0
  const failure = new Error('Invalid identity')
  await assert.rejects(
    retryUnreachablePeerStart(async () => {
      attempts += 1
      throw failure
    }),
    (error) => error === failure,
  )
  assert.equal(attempts, 1)

  attempts = 0
  await assert.rejects(
    retryUnreachablePeerStart(async () => {
      attempts += 1
      throw new UnreachablePeerError()
    }),
    UnreachablePeerError,
  )
  assert.equal(attempts, 2)
})
