import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeUntilRevoked,
  canCreateShare,
  createShareDraft,
  setDuration,
  setPrecision,
  setViewerCapacity,
} from "./shareDraft.ts";

test("new shares use privacy-preserving defaults", () => {
  assert.deepEqual(createShareDraft(), {
    precision: "approximate",
    duration: "1h",
    viewerCapacity: 1,
    untilRevokedAcknowledged: false,
  });
});

test("share updates return new drafts without mutating the original", () => {
  const initial = createShareDraft();
  const exact = setPrecision(initial, "exact");
  const expanded = setViewerCapacity(exact, 10);

  assert.equal(initial.precision, "approximate");
  assert.equal(exact.precision, "exact");
  assert.equal(expanded.viewerCapacity, 10);
  assert.notEqual(initial, exact);
  assert.notEqual(exact, expanded);
});

test("until-revoked sharing requires explicit acknowledgement every time", () => {
  const indefinite = setDuration(createShareDraft(), "until-revoked");
  assert.equal(canCreateShare(indefinite), false);

  const acknowledged = acknowledgeUntilRevoked(indefinite, true);
  assert.equal(canCreateShare(acknowledged), true);

  const timed = setDuration(acknowledged, "8h");
  const indefiniteAgain = setDuration(timed, "until-revoked");
  assert.equal(indefiniteAgain.untilRevokedAcknowledged, false);
  assert.equal(canCreateShare(indefiniteAgain), false);
});
