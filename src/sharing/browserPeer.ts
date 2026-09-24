import {
  ensureRelayReservation,
  startBrowserLibp2p,
  type BrowserLibp2pNode,
} from '@taskyon/p2p-core/browser'
import { PRIMARY_RELAY_WS_MULTIADDR } from '@taskyon/p2p-core/constants'
import { createLibp2pMessagePort } from '@taskyon/p2p-core/messagePort'
import type { PrivateKey, Stream } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import type { ProtocolMessage } from '@taskyon/protocol'

import { constellationProtocolV1 } from './shareProtocol.ts'

export type ConstellationMessage = ProtocolMessage<typeof constellationProtocolV1>

const jsonCodec = {
  encode: (message: ConstellationMessage): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(message)),
  decode: (bytes: Uint8Array): ConstellationMessage =>
    constellationProtocolV1.message.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    ) as ConstellationMessage,
}

export const createConstellationMessagePort = (stream: Stream) =>
  createLibp2pMessagePort<ConstellationMessage, ConstellationMessage>(stream, jsonCodec, {
    maxMessageBytes: 8_192,
    maxPendingMessages: 32,
  })

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
      address.startsWith(`${connectedRelayAddress}/p2p-circuit/p2p/`) &&
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

export const requireReachablePeer = async <Node extends Pick<BrowserLibp2pNode, 'stop'>>(
  node: Node,
  addresses: string[],
): Promise<string[]> => {
  if (addresses.length > 0) return addresses
  await node.stop()
  throw new Error('No reachable P2P address is available.')
}

export const startPrivateBrowserPeer = async (
  privateKey?: PrivateKey,
): Promise<{
  node: BrowserLibp2pNode
  addresses: string[]
}> => {
  const node = await startBrowserLibp2p({ logNamespaces: '', privateKey })
  let reservedRelay: string | undefined
  for (const address of configuredRelays()) {
    try {
      const connection = await node.dial(multiaddr(address))
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

export const orderShareAddresses = (addresses: readonly string[]): string[] =>
  [...addresses].sort((left, right) => {
    const rank = (address: string) =>
      address.includes('/p2p-circuit/webrtc') ? 2 : address.includes('/p2p-circuit') ? 0 : 1
    return rank(left) - rank(right)
  })

export const dialShareStream = async (
  node: Pick<BrowserLibp2pNode, 'dialProtocol'>,
  addresses: readonly string[],
  protocol: string,
): Promise<Stream> => {
  const ordered = orderShareAddresses(addresses)
  let lastError: unknown
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
