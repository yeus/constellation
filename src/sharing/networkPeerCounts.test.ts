import assert from 'node:assert/strict'
import test from 'node:test'
import { countPeerPaths } from './networkPeerCounts.ts'
import type { NetworkDiagnostics } from './sharingRuntime.ts'

const make = (
  peerId: string,
  transport: NetworkDiagnostics['connections'][number]['transport'],
  role: NetworkDiagnostics['connections'][number]['role'] = 'viewer',
  status = 'open',
): NetworkDiagnostics['connections'][number] => ({
  peerId,
  transport,
  role,
  status,
  direction: 'outbound',
  remoteAddress: 'redacted',
})

test('counts distinct peers by path, excluding relay infrastructure and closed connections', () => {
  assert.deepEqual(
    countPeerPaths([
      make('direct-1', 'WebRTC'),
      make('direct-1', 'WebRTC'),
      make('direct-2', 'WebTransport', 'source'),
      make('relay-1', 'relay circuit'),
      make('both-1', 'relay circuit'),
      make('both-1', 'WebRTC'),
      make('relay-node', 'relay circuit', 'other peer'),
      make('closed', 'WebSocket', 'viewer', 'closed'),
    ]),
    { direct: 2, viaRelay: 1, both: 1 },
  )
})

test('classifies WebRTC negotiated over relay as direct data connection', () => {
  assert.deepEqual(countPeerPaths([make('one', 'WebRTC over relay')]), {
    direct: 1,
    viaRelay: 0,
    both: 0,
  })
})
