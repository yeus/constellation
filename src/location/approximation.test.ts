import assert from "node:assert/strict";
import test from "node:test";

import { LOCATION_PROFILE_V1, type LocationObservationV1 } from "./locationObservation.ts";
import {
  circleOverlapRatio,
  distanceMeters,
  projectApproximateLocation,
} from "./approximation.ts";

const exactObservation = (
  latitude: number,
  longitude: number,
  accuracyMeters = 12,
  sequence = 1,
): LocationObservationV1 => ({
  profile: LOCATION_PROFILE_V1,
  sourceId: "synthetic-source",
  precision: "exact",
  sequence,
  capturedAt: sequence * 1_000,
  expiresAt: sequence * 1_000 + 60_000,
  latitude,
  longitude,
  accuracyMeters,
  altitudeMeters: 100,
  headingDegrees: 90,
  speedMps: 2,
});

const randomValues = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length] ?? 0.5;
};

test("creates a nonzero stable region that contains the reported uncertainty", () => {
  const first = projectApproximateLocation(
    exactObservation(52.52, 13.405),
    undefined,
    randomValues(0.1, 0.5, 0.7),
  );
  const second = projectApproximateLocation(
    exactObservation(52.5201, 13.4051, 12, 2),
    first.state,
    randomValues(0.2, 0.6, 0.8),
  );
  const offset = distanceMeters(
    first.observation.latitude,
    first.observation.longitude,
    52.52,
    13.405,
  );

  assert.ok(offset > 0);
  assert.ok(offset + 12 <= first.observation.accuracyMeters);
  assert.equal(second.observation.latitude, first.observation.latitude);
  assert.equal(second.observation.longitude, first.observation.longitude);
  assert.equal("speedMps" in first.observation, false);
  assert.equal("headingDegrees" in first.observation, false);
  assert.equal("altitudeMeters" in first.observation, false);
})

test("transitions with overlap and enlarges for poor accuracy", () => {
  const first = projectApproximateLocation(
    exactObservation(0, 0),
    undefined,
    randomValues(0.1, 0.5, 0.1),
  );
  const moved = exactObservation(0.009, 0, 1_200, 2);
  const next = projectApproximateLocation(moved, first.state, randomValues(0.7, 0.5, 0.9));
  const centers = distanceMeters(
    first.state.latitude,
    first.state.longitude,
    next.state.latitude,
    next.state.longitude,
  );

  assert.ok(
    distanceMeters(next.state.latitude, next.state.longitude, moved.latitude, moved.longitude) +
      moved.accuracyMeters <=
      next.state.radiusMeters,
  );
  assert.ok(
    circleOverlapRatio(first.state.radiusMeters, next.state.radiusMeters, centers) >= 0.75,
  );
})
