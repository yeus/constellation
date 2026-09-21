import assert from "node:assert/strict";
import test from "node:test";

import {
  createShareInvitation,
  parseShareInvitation,
} from "./shareLink.ts";

const randomBytes = (length: number) =>
  Uint8Array.from({ length }, (_, index) => index + 1);

test("keeps every capability field in the URL fragment", () => {
  const invitation = createShareInvitation({
    baseUrl: "https://constellation.example/share",
    sourcePeerId: "synthetic-source-peer",
    addresses: ["/dns4/relay.example/tcp/443/wss/p2p/synthetic"],
    expiresAt: 10_000,
    randomBytes,
  });
  const url = new URL(invitation.url);

  assert.equal(url.search, "");
  assert.equal(url.pathname, "/share");
  assert.match(url.hash, /^#share=/);
  assert.deepEqual(parseShareInvitation(invitation.url, 1), invitation.capability);
})

test("rejects expired and oversized invitations", () => {
  const invitation = createShareInvitation({
    baseUrl: "https://constellation.example/share",
    sourcePeerId: "synthetic-source-peer",
    addresses: [],
    expiresAt: 10,
    randomBytes,
  });

  assert.throws(() => parseShareInvitation(invitation.url, 10), /expired/i);
  assert.throws(
    () => parseShareInvitation(`https://constellation.example/share#share=${"a".repeat(1_801)}`, 1),
    /too large/i,
  );
})
