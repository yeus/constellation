import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCATION_PROFILE_V1,
  parseLocationObservationV1,
} from "./locationObservation.ts";

const validObservation = {
  profile: LOCATION_PROFILE_V1,
  sourceId: "synthetic-source",
  precision: "exact",
  sequence: 7,
  capturedAt: 1_000,
  expiresAt: 31_000,
  latitude: 40,
  longitude: -70,
  accuracyMeters: 12,
  altitudeMeters: 25,
  headingDegrees: 90,
  speedMps: 1.5,
} as const;

test("parses a bounded versioned location observation", () => {
  assert.deepEqual(
    parseLocationObservationV1(validObservation),
    validObservation,
  );
});

test("rejects invalid coordinates, freshness, sequence, and movement fields", () => {
  const invalidCases = [
    { ...validObservation, latitude: 91 },
    { ...validObservation, longitude: -181 },
    { ...validObservation, accuracyMeters: 0 },
    { ...validObservation, sequence: -1 },
    { ...validObservation, expiresAt: validObservation.capturedAt },
    { ...validObservation, headingDegrees: 360 },
    { ...validObservation, speedMps: -1 },
    { ...validObservation, precision: "unknown" },
  ];

  invalidCases.forEach((value) =>
    assert.throws(() => parseLocationObservationV1(value)),
  );
});

test("rejects unknown profile versions", () => {
  assert.throws(
    () =>
      parseLocationObservationV1({
        ...validObservation,
        profile: "dev.constellation.location/v2",
      }),
    /profile/i,
  );
});
