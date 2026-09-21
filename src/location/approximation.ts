import { parseLocationObservationV1, type LocationObservationV1 } from "./locationObservation.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEFAULT_RADIUS_METERS = 1_000;
const SAFETY_MARGIN_METERS = 50;

export interface ApproximationState {
  readonly latitude: number;
  readonly longitude: number;
  readonly radiusMeters: number;
  readonly thresholdMeters: number;
  readonly beyondThresholdCount: number;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;

export const distanceMeters = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number => {
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
};

const destination = (
  latitude: number,
  longitude: number,
  distance: number,
  bearing: number,
): { latitude: number; longitude: number } => {
  const angularDistance = distance / EARTH_RADIUS_METERS;
  const sourceLatitude = radians(latitude);
  const sourceLongitude = radians(longitude);
  const targetLatitude = Math.asin(
    Math.sin(sourceLatitude) * Math.cos(angularDistance) +
      Math.cos(sourceLatitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const targetLongitude =
    sourceLongitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(sourceLatitude),
      Math.cos(angularDistance) - Math.sin(sourceLatitude) * Math.sin(targetLatitude),
    );
  return {
    latitude: degrees(targetLatitude),
    longitude: ((degrees(targetLongitude) + 540) % 360) - 180,
  };
};

export const circleOverlapRatio = (radiusA: number, radiusB: number, distance: number): number => {
  const smallerArea = Math.PI * Math.min(radiusA, radiusB) ** 2;
  if (distance >= radiusA + radiusB) return 0;
  if (distance <= Math.abs(radiusA - radiusB)) return 1;
  const alpha = Math.acos((distance ** 2 + radiusA ** 2 - radiusB ** 2) / (2 * distance * radiusA));
  const beta = Math.acos((distance ** 2 + radiusB ** 2 - radiusA ** 2) / (2 * distance * radiusB));
  const lens =
    radiusA ** 2 * alpha +
    radiusB ** 2 * beta -
    0.5 * Math.sqrt(
      (-distance + radiusA + radiusB) *
        (distance + radiusA - radiusB) *
        (distance - radiusA + radiusB) *
        (distance + radiusA + radiusB),
    );
  return lens / smallerArea;
};

const randomUnit = (random: () => number): number => {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Random values must be between zero inclusive and one exclusive.");
  }
  return value;
};

const createRegion = (
  observation: LocationObservationV1,
  previous: ApproximationState | undefined,
  random: () => number,
): ApproximationState => {
  const baseRadius = Math.max(
    DEFAULT_RADIUS_METERS,
    observation.accuracyMeters + 400,
    previous?.radiusMeters ?? 0,
  );
  const safeOffset = baseRadius - observation.accuracyMeters - SAFETY_MARGIN_METERS;
  const minimumOffset = Math.min(100, safeOffset * 0.25);
  const maximumOffset = Math.min(300, safeOffset * 0.6);
  const offset = minimumOffset + (maximumOffset - minimumOffset) * randomUnit(random);
  const center = destination(
    observation.latitude,
    observation.longitude,
    offset,
    randomUnit(random) * Math.PI * 2,
  );
  const centerDistance = previous
    ? distanceMeters(previous.latitude, previous.longitude, center.latitude, center.longitude)
    : 0;
  let radius = Math.max(baseRadius, offset + observation.accuracyMeters + SAFETY_MARGIN_METERS);
  while (
    previous &&
    circleOverlapRatio(previous.radiusMeters, radius, centerDistance) < 0.75
  ) {
    radius *= 1.1;
  }
  const remaining = radius - observation.accuracyMeters - offset;
  const threshold = offset + remaining * (0.35 + randomUnit(random) * 0.2);
  return {
    ...center,
    radiusMeters: radius,
    thresholdMeters: threshold,
    beyondThresholdCount: 0,
  };
};

export const projectApproximateLocation = (
  observation: LocationObservationV1,
  previous: ApproximationState | undefined,
  random: () => number = () => {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    if (value === undefined) throw new Error("Secure random generation failed.");
    return value / 2 ** 32;
  },
): { observation: LocationObservationV1; state: ApproximationState } => {
  const distance = previous
    ? distanceMeters(previous.latitude, previous.longitude, observation.latitude, observation.longitude)
    : 0;
  const containmentFailed = previous
    ? distance + observation.accuracyMeters > previous.radiusMeters
    : false;
  const beyondCount = previous && distance > previous.thresholdMeters
    ? previous.beyondThresholdCount + 1
    : 0;
  const state = !previous || containmentFailed || beyondCount >= 2
    ? createRegion(observation, previous, random)
    : { ...previous, beyondThresholdCount: beyondCount };

  return {
    state,
    observation: parseLocationObservationV1({
      profile: observation.profile,
      sourceId: observation.sourceId,
      precision: "approximate",
      sequence: observation.sequence,
      capturedAt: observation.capturedAt,
      expiresAt: observation.expiresAt,
      latitude: state.latitude,
      longitude: state.longitude,
      accuracyMeters: state.radiusMeters,
    }),
  };
};
