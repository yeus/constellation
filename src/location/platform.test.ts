import assert from "node:assert/strict";
import test from "node:test";

import { createTauriGeolocationAdapter } from "./platform.ts";

const position = {
  timestamp: 1_000,
  coords: {
    latitude: 40,
    longitude: -70,
    accuracy: 4,
    altitude: null,
    heading: null,
    speed: null,
  },
};

test("requests Tauri location permission before watching", async () => {
  const calls: string[] = [];
  const adapter = createTauriGeolocationAdapter(async () => ({
    checkPermissions: async () => {
      calls.push("check");
      return { location: "prompt" };
    },
    requestPermissions: async () => {
      calls.push("request");
      return { location: "granted" };
    },
    watchPosition: async (options, observer) => {
      calls.push(`watch:${String(options.enableHighAccuracy)}`);
      observer(position);
      return 7;
    },
    clearWatch: async (watchId) => {
      calls.push(`clear:${watchId}`);
    },
  }));
  const received: number[] = [];

  const watchId = await adapter.watchPosition(
    (value) => received.push(value.coords.accuracy),
    undefined,
    { enableHighAccuracy: true },
  );
  await adapter.clearWatch(watchId);

  assert.equal(watchId, 7);
  assert.deepEqual(received, [4]);
  assert.deepEqual(calls, ["check", "request", "watch:true", "clear:7"]);
});

test("reports denied Tauri permission as a geolocation denial", async () => {
  const adapter = createTauriGeolocationAdapter(async () => ({
    checkPermissions: async () => ({ location: "denied" }),
    requestPermissions: async () => ({ location: "denied" }),
    watchPosition: async () => 1,
    clearWatch: async () => undefined,
  }));
  let errorCode: number | undefined;

  await assert.rejects(
    Promise.resolve(
      adapter.watchPosition(
        () => undefined,
        (error) => {
          errorCode = error.code;
        },
      ),
    ),
  );

  assert.equal(errorCode, 1);
});
