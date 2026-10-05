import { createServer } from 'node:http'

import { startRelayLibp2p } from '@taskyon/p2p-core/relay'

const relay = await startRelayLibp2p({
  logName: 'constellation-e2e-relay',
  listenAddrs: ['/ip4/127.0.0.1/tcp/9111/ws'],
  minConnections: 0,
  reservationExpirationMs: 60_000,
  autoNatPollMs: 3_600_000,
})
const health = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404)
  response.end()
})

await new Promise((resolve, reject) => {
  health.once('error', reject)
  health.listen(9113, '127.0.0.1', resolve)
})

const stop = () => {
  health.close()
  void relay.stop().finally(() => process.exit())
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
