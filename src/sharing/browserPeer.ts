import {
  ensureRelayReservation,
  startBrowserLibp2p,
  type BrowserLibp2pNode,
} from "@taskyon/p2p-core/browser";
import { PRIMARY_RELAY_WS_MULTIADDR } from "@taskyon/p2p-core/constants";
import { createLibp2pMessagePort } from "@taskyon/p2p-core/messagePort";
import type { Stream } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import type { ProtocolMessage } from "@taskyon/protocol";

import { constellationProtocolV1 } from "./shareProtocol.ts";

export type ConstellationMessage = ProtocolMessage<typeof constellationProtocolV1>;

const jsonCodec = {
  encode: (message: ConstellationMessage): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(message)),
  decode: (bytes: Uint8Array): ConstellationMessage =>
    constellationProtocolV1.message.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    ) as ConstellationMessage,
};

export const createConstellationMessagePort = (stream: Stream) =>
  createLibp2pMessagePort<ConstellationMessage, ConstellationMessage>(
    stream,
    jsonCodec,
    { maxMessageBytes: 8_192, maxPendingMessages: 32 },
  );

const configuredRelays = (): string[] => {
  const value = import.meta.env.VITE_CONSTELLATION_RELAY_ADDRS;
  const addresses = value
    ?.split(",")
    .map((address: string) => address.trim())
    .filter(Boolean);
  return addresses?.length ? addresses : [PRIMARY_RELAY_WS_MULTIADDR];
};

const waitForReachabilityAddresses = async (
  node: BrowserLibp2pNode,
  relayAddress: string | undefined,
): Promise<string[]> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const addresses = node.getMultiaddrs().map((address) => address.toString());
    const reachable = relayAddress
      ? addresses.filter((address) => address.startsWith(`${relayAddress}/p2p/`))
      : [];
    if (reachable.some((address) => address.includes("/p2p-circuit"))) {
      return reachable.slice(0, 4);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return [];
};

export const startPrivateBrowserPeer = async (): Promise<{
  node: BrowserLibp2pNode;
  addresses: string[];
}> => {
  const node = await startBrowserLibp2p({ logNamespaces: "" });
  let reservedRelay: string | undefined;
  for (const address of configuredRelays()) {
    try {
      const connection = await node.dial(multiaddr(address));
      if (
        await ensureRelayReservation(
          node,
          multiaddr(connection.remoteAddr.toString()),
        )
      ) {
        reservedRelay = address;
        break;
      }
    } catch {
      // The next configured relay may still provide reachability.
    }
  }
  return {
    node,
    addresses: await waitForReachabilityAddresses(node, reservedRelay),
  };
};

export const dialShareStream = async (
  node: BrowserLibp2pNode,
  addresses: readonly string[],
  protocol: string,
): Promise<Stream> => {
  const ordered = [...addresses].sort(
    (left, right) =>
      Number(left.includes("/p2p-circuit")) -
      Number(right.includes("/p2p-circuit")),
  );
  let lastError: unknown;
  for (const address of ordered) {
    try {
      return await node.dialProtocol(multiaddr(address), protocol);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No share address was reachable.");
};
