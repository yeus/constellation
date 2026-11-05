import {
  ensureRelayReservation,
  startBrowserLibp2p,
  type BrowserLibp2pNode,
} from '@taskyon/p2p-core/browser'
import { PRIMARY_RELAY_WS_MULTIADDR } from '@taskyon/p2p-core/constants'
import { createLibp2pMessagePort } from '@taskyon/p2p-core/messagePort'
import type { Connection, PrivateKey, Stream } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'

export const createProtocolMessagePort = <Message>(
  stream: Stream,
  parse: (value: unknown) => Message,
) =>
  createLibp2pMessagePort<Message, Message>(
    stream,
    {
      encode: (message) => new TextEncoder().encode(JSON.stringify(message)),
      decode: (bytes) => parse(JSON.parse(new TextDecoder().decode(bytes))),
    },
    {
      maxMessageBytes: 8_192,
      maxPendingMessages: 32,
    },
  )

const configuredRelays = (): string[] => {
  const value = import.meta.env.VITE_CONSTELLATION_RELAY_ADDRS
  const addresses = value
    ?.split(',')
    .map((address: string) => address.trim())
    .filter(Boolean)
  return addresses?.length ? addresses : [PRIMARY_RELAY_WS_MULTIADDR]
}

export const reachableRelayAddresses = (
  addresses: readonly string[],
  connectedRelayAddress: string,
): string[] =>
  addresses.filter(
    (address) =>
      (address.startsWith(`${connectedRelayAddress}/p2p-circuit/p2p/`) ||
        address.startsWith(`${connectedRelayAddress}/p2p-circuit/webrtc/p2p/`)) &&
      !address.includes('/p2p-circuit/p2p-circuit'),
  )

const waitForReachabilityAddresses = async (
  node: BrowserLibp2pNode,
  relayAddress: string | undefined,
): Promise<string[]> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const addresses = node.getMultiaddrs().map((address) => address.toString())
    const reachable = relayAddress ? reachableRelayAddresses(addresses, relayAddress) : []
    if (reachable.length > 0) return reachable.slice(0, 4)
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return []
}

export class UnreachablePeerError extends Error {
  constructor() {
    super('No reachable P2P address is available.')
    this.name = 'UnreachablePeerError'
  }
}

// One transient relay reservation failure should not abort sharing. The
// failing attempt has already stopped its libp2p node before this is called;
// do not retry identity, permission, or protocol failures.
export const retryUnreachablePeerStart = async <Result>(
  start: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await start()
  } catch (error) {
    if (!(error instanceof UnreachablePeerError)) throw error
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  return start()
}

export const requireReachablePeer = async <Node extends Pick<BrowserLibp2pNode, 'stop'>>(
  node: Node,
  addresses: string[],
): Promise<string[]> => {
  if (addresses.length > 0) return addresses
  await node.stop()
  throw new UnreachablePeerError()
}

const RELAY_CONNECT_TIMEOUT_MS = 10_000

const startPrivateBrowserPeerOnce = async (
  privateKey?: PrivateKey,
): Promise<{
  node: BrowserLibp2pNode
  addresses: string[]
}> => {
  const node = await startBrowserLibp2p({
    logNamespaces: '',
    privateKey,
    discovery: 'disabled',
    relayAddrs: [],
  })
  let reservedRelay: string | undefined
  for (const address of configuredRelays()) {
    try {
      const connection = await node.dial(multiaddr(address), {
        signal: AbortSignal.timeout(RELAY_CONNECT_TIMEOUT_MS),
      })
      const connectedRelayAddress = connection.remoteAddr.toString()
      if (await ensureRelayReservation(node, multiaddr(connectedRelayAddress))) {
        reservedRelay = connectedRelayAddress
        break
      }
    } catch {
      // The next configured relay may still provide reachability.
    }
  }
  const addresses = await waitForReachabilityAddresses(node, reservedRelay)
  return { node, addresses: await requireReachablePeer(node, addresses) }
}
export const startPrivateBrowserPeer = (privateKey?: PrivateKey) =>
  retryUnreachablePeerStart(() => startPrivateBrowserPeerOnce(privateKey))

export const orderShareAddresses = (addresses: readonly string[]): string[] =>
  [...addresses].sort((left, right) => {
    const rank = (address: string) =>
      address.includes('/p2p-circuit/webrtc') ? 2 : address.includes('/p2p-circuit') ? 1 : 0
    return rank(left) - rank(right)
  })

export const dialShareStream = async (
  node: Pick<BrowserLibp2pNode, 'dialProtocol'>,
  addresses: readonly string[],
  protocol: string | string[],
  connections: readonly Connection[] = [],
): Promise<Stream> => {
  const ordered = orderShareAddresses(addresses)
  let lastError: unknown
  for (const connection of [...connections].sort(
    (left, right) => Number(right.direct) - Number(left.direct),
  )) {
    try {
      return await connection.newStream(protocol, { runOnLimitedConnection: true })
    } catch (error) {
      lastError = error
    }
  }
  for (const address of ordered) {
    try {
      return await node.dialProtocol(multiaddr(address), protocol, {
        runOnLimitedConnection: true,
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No share address was reachable.')
}
