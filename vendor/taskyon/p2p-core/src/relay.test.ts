import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport, type CircuitRelayService } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { disable } from '@libp2p/logger'
import { tcp } from '@libp2p/tcp'
import { createLibp2p } from 'libp2p'

import { startRelayLibp2p } from './relay.ts'

for (const lifetime of [undefined, 1_000]) {
  test(
    lifetime === undefined
      ? 'relay retains the effective two-hour default lifetime'
      : 'configured relay reservation expiry releases a slot after a client stops',
    async (t) => {
      // Synthetic peers only; suppress transport logs that include ephemeral identities.
      t.mock.method(console, 'log', () => undefined)
      t.mock.method(console, 'error', () => undefined)
      t.mock.method(process.stderr, 'write', () => true)
      const relay = await startRelayLibp2p({
        listenAddrs: ['/ip4/127.0.0.1/tcp/0'],
        maxReservations: 1,
        reservationExpirationMs: lifetime,
        minConnections: 0,
      })
      disable()
      const reservations = (relay.services.relay as CircuitRelayService).reservations
      let client: Awaited<ReturnType<typeof createLibp2p>> | undefined
      try {
        client = await createLibp2p({
          addresses: { listen: [relay.getMultiaddrs()[0]!.encapsulate('/p2p-circuit').toString()] },
          transports: [tcp(), circuitRelayTransport()],
          connectionEncrypters: [noise()],
          streamMuxers: [yamux()],
          services: { identify: identify() },
        })
        assert.equal(reservations.size, 1)
        const reservation = reservations.get(client.peerId)!
        const expectedLifetime = lifetime ?? 7_200_000
        const remaining = reservation.expiry.getTime() - Date.now()
        assert.ok(remaining <= expectedLifetime && remaining > expectedLifetime / 2)
        await client.stop()
        if (lifetime !== undefined) {
          await setTimeout(1_200)
          assert.equal(reservations.size, 0)
        }
      } finally {
        await client?.stop()
        await relay.stop()
      }
      assert.equal(reservations.size, 0)
    },
  )
}
