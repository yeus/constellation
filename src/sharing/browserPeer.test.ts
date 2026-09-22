import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserLibp2pNode } from "@taskyon/p2p-core/browser";

import { dialShareStream, orderShareAddresses } from "./browserPeer.ts";

test("prefers plain circuit relay before WebRTC-over-relay", () => {
  const webRtc = "/dns4/relay.invalid/tcp/443/wss/p2p-circuit/webrtc";
  const circuit = "/dns4/relay.invalid/tcp/443/wss/p2p-circuit";

  assert.deepEqual(orderShareAddresses([webRtc, circuit]), [circuit, webRtc]);
});

test("share streams may run over limited relay connections", async () => {
  const expectedError = new Error("dial stopped after options were captured");
  let receivedOptions: unknown;
  const node = {
    dialProtocol: async (_peer, _protocol, options) => {
      receivedOptions = options;
      throw expectedError;
    },
  } satisfies Pick<BrowserLibp2pNode, "dialProtocol">;

  await assert.rejects(
    dialShareStream(node, ["/ip4/127.0.0.1/tcp/1"], "/constellation/test/1.0.0"),
    expectedError,
  );
  assert.deepEqual(receivedOptions, { runOnLimitedConnection: true });
});
