import type { Feature, FeatureCollection, Point, Polygon } from "geojson";

import type { LocationObservationV1 } from "./locationObservation.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;
const AREA_SEGMENTS = 48;

export interface MapLocation {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly precision: "exact" | "approximate";
  readonly accuracyMeters?: number;
  readonly radiusMeters?: number;
  readonly label?: string;
  readonly state?: "live" | "delayed" | "stale";
}

interface LocationProperties {
  readonly id: string;
  readonly precision: MapLocation["precision"];
  readonly shape: "position" | "accuracy" | "approximate";
  readonly label?: string;
  readonly state: NonNullable<MapLocation["state"]>;
}

export const locationObservationToMapLocation = (
  observation: LocationObservationV1,
  state: NonNullable<MapLocation["state"]> = "live",
): MapLocation => ({
  id: observation.sourceId,
  latitude: observation.latitude,
  longitude: observation.longitude,
  precision: observation.precision,
  ...(observation.precision === "exact"
    ? { accuracyMeters: observation.accuracyMeters }
    : { radiusMeters: observation.accuracyMeters }),
  state,
});

const assertLocation = (location: MapLocation): void => {
  if (
    !Number.isFinite(location.latitude) ||
    location.latitude < -90 ||
    location.latitude > 90
  ) {
    throw new RangeError(`Invalid latitude for location ${location.id}.`);
  }
  if (
    !Number.isFinite(location.longitude) ||
    location.longitude < -180 ||
    location.longitude > 180
  ) {
    throw new RangeError(`Invalid longitude for location ${location.id}.`);
  }
};

const propertiesFor = (
  location: MapLocation,
  shape: LocationProperties["shape"],
): LocationProperties => ({
  id: location.id,
  precision: location.precision,
  shape,
  state: location.state ?? "live",
  ...(location.label === undefined ? {} : { label: location.label }),
});

const uncertaintyRing = (location: MapLocation, radius: number): number[][] => {
  const latitudeRadians = (location.latitude * Math.PI) / 180;
  const angularDistance = radius / EARTH_RADIUS_METERS;
  const ring = Array.from({ length: AREA_SEGMENTS }, (_, index) => {
    const bearing = (index / AREA_SEGMENTS) * Math.PI * 2;
    const latitude = Math.asin(
      Math.sin(latitudeRadians) * Math.cos(angularDistance) +
        Math.cos(latitudeRadians) *
          Math.sin(angularDistance) *
          Math.cos(bearing),
    );
    const longitude =
      (location.longitude * Math.PI) / 180 +
      Math.atan2(
        Math.sin(bearing) *
          Math.sin(angularDistance) *
          Math.cos(latitudeRadians),
        Math.cos(angularDistance) -
          Math.sin(latitudeRadians) * Math.sin(latitude),
      );
    return [(longitude * 180) / Math.PI, (latitude * 180) / Math.PI];
  });
  const first = ring[0];
  if (!first) throw new Error("Location uncertainty ring is empty.");
  return [...ring, first];
};

const areaFeature = (
  location: MapLocation,
  radius: number,
  shape: "accuracy" | "approximate",
): Feature<Polygon, LocationProperties> => ({
  type: "Feature",
  properties: propertiesFor(location, shape),
  geometry: {
    type: "Polygon",
    coordinates: [uncertaintyRing(location, radius)],
  },
});

const featuresFor = (
  location: MapLocation,
): Feature<Point | Polygon, LocationProperties>[] => {
  assertLocation(location);
  if (location.precision === "approximate") {
    if (
      location.radiusMeters === undefined ||
      !Number.isFinite(location.radiusMeters) ||
      location.radiusMeters <= 0
    ) {
      throw new RangeError(`Invalid approximate radius for ${location.id}.`);
    }
    return [areaFeature(location, location.radiusMeters, "approximate")];
  }

  if (
    location.accuracyMeters !== undefined &&
    (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters <= 0)
  ) {
    throw new RangeError(`Invalid accuracy for ${location.id}.`);
  }
  const point: Feature<Point, LocationProperties> = {
    type: "Feature",
    properties: propertiesFor(location, "position"),
    geometry: {
      type: "Point",
      coordinates: [location.longitude, location.latitude],
    },
  };
  return [
    point,
    ...(location.accuracyMeters === undefined
      ? []
      : [areaFeature(location, location.accuracyMeters, "accuracy")]),
  ];
};

export const createLocationFeatureCollection = (
  locations: readonly MapLocation[],
): FeatureCollection<Point | Polygon, LocationProperties> => ({
  type: "FeatureCollection",
  features: locations.flatMap(featuresFor),
});
