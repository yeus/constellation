import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'

import type { LocationObservationV1 } from './locationObservation.ts'

const EARTH_RADIUS_METERS = 6_371_008.8
const AREA_SEGMENTS = 48
const WEB_MERCATOR_CIRCUMFERENCE_METERS = 2 * Math.PI * 6_378_137
export const LOCATION_MARKER_RADIUS_PX = 7
export const LOCATION_MARKER_STROKE_PX = 2

export interface MapLocation {
  readonly id: string
  readonly isOwn?: boolean
  readonly latitude: number
  readonly longitude: number
  readonly precision: 'exact' | 'approximate'
  readonly accuracyMeters?: number
  readonly radiusMeters?: number
  readonly label?: string
  readonly color?: string
  readonly state?: 'live' | 'delayed' | 'stale'
}

interface LocationProperties {
  readonly id: string
  readonly precision: MapLocation['precision']
  readonly shape: 'position' | 'accuracy' | 'approximate'
  readonly label?: string
  readonly color?: string
  readonly state: NonNullable<MapLocation['state']>
}

export const locationObservationToMapLocation = (
  observation: LocationObservationV1,
  state: NonNullable<MapLocation['state']> = 'live',
  display: { readonly id?: string; readonly label?: string; readonly color?: string } = {},
): MapLocation => ({
  id: display.id ?? observation.sourceId,
  latitude: observation.latitude,
  longitude: observation.longitude,
  precision: observation.precision,
  ...(observation.precision === 'exact'
    ? { accuracyMeters: observation.accuracyMeters }
    : { radiusMeters: observation.accuracyMeters }),
  state,
  ...(display.label ? { label: display.label } : {}),
  ...(display.color ? { color: display.color } : {}),
})

const assertLocation = (location: MapLocation): void => {
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
    throw new RangeError(`Invalid latitude for location ${location.id}.`)
  }
  if (
    !Number.isFinite(location.longitude) ||
    location.longitude < -180 ||
    location.longitude > 180
  ) {
    throw new RangeError(`Invalid longitude for location ${location.id}.`)
  }
}

const propertiesFor = (
  location: MapLocation,
  shape: LocationProperties['shape'],
): LocationProperties => ({
  id: location.id,
  precision: location.precision,
  shape,
  state: location.state ?? 'live',
  ...(location.label === undefined ? {} : { label: location.label }),
  ...(location.color === undefined ? {} : { color: location.color }),
})

const uncertaintyRing = (location: MapLocation, radius: number): [number, number][] => {
  const latitudeRadians = (location.latitude * Math.PI) / 180
  const angularDistance = radius / EARTH_RADIUS_METERS
  const ring: [number, number][] = Array.from({ length: AREA_SEGMENTS }, (_, index) => {
    const bearing = (index / AREA_SEGMENTS) * Math.PI * 2
    const latitude = Math.asin(
      Math.sin(latitudeRadians) * Math.cos(angularDistance) +
        Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
    )
    const longitude =
      (location.longitude * Math.PI) / 180 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
        Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(latitude),
      )
    return [(longitude * 180) / Math.PI, (latitude * 180) / Math.PI]
  })
  const first = ring[0]
  if (!first) throw new Error('Location uncertainty ring is empty.')
  return [...ring, first]
}

export const locationUncertaintyRing = (location: MapLocation): readonly [number, number][] => {
  assertLocation(location)
  const radius =
    location.precision === 'approximate' ? location.radiusMeters : location.accuracyMeters
  if (radius === undefined) return []
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError(`Invalid uncertainty radius for location ${location.id}.`)
  }
  return uncertaintyRing(location, radius)
}

const areaFeature = (
  location: MapLocation,
  radius: number,
  shape: 'accuracy' | 'approximate',
): Feature<Polygon, LocationProperties> => ({
  type: 'Feature',
  properties: propertiesFor(location, shape),
  geometry: {
    type: 'Polygon',
    coordinates: [uncertaintyRing(location, radius)],
  },
})

const pointFeature = (
  location: MapLocation,
  shape: LocationProperties['shape'],
): Feature<Point, LocationProperties> => ({
  type: 'Feature',
  properties: propertiesFor(location, shape),
  geometry: {
    type: 'Point',
    coordinates: [location.longitude, location.latitude],
  },
})

const areaFitsInsideMarker = (location: MapLocation, radius: number, zoom?: number): boolean => {
  if (zoom === undefined) return false
  const latitude = (location.latitude * Math.PI) / 180
  const circumference = WEB_MERCATOR_CIRCUMFERENCE_METERS * Math.cos(latitude)
  const radiusPixels = (radius * 512 * 2 ** zoom) / circumference
  return radiusPixels <= LOCATION_MARKER_RADIUS_PX + LOCATION_MARKER_STROKE_PX
}

export const locationAreaBounds = (
  location: MapLocation,
): [[number, number], [number, number]] | undefined => {
  assertLocation(location)
  const radius =
    location.precision === 'approximate' ? location.radiusMeters : location.accuracyMeters
  if (radius === undefined) return undefined
  if (!Number.isFinite(radius) || radius <= 0)
    throw new RangeError(`Invalid area radius for ${location.id}.`)
  const ring = uncertaintyRing(location, radius)
  return [
    [
      Math.min(...ring.map(([longitude]) => longitude)),
      Math.min(...ring.map(([, latitude]) => latitude)),
    ],
    [
      Math.max(...ring.map(([longitude]) => longitude)),
      Math.max(...ring.map(([, latitude]) => latitude)),
    ],
  ]
}

export const locationsBounds = (
  locations: readonly MapLocation[],
): [[number, number], [number, number]] | undefined => {
  const anchor = locations[0]?.longitude
  if (anchor === undefined) return undefined
  return locations.reduce<[[number, number], [number, number]] | undefined>(
    (combined, location) => {
      const area: [[number, number], [number, number]] = locationAreaBounds(location) ?? [
        [location.longitude, location.latitude],
        [location.longitude, location.latitude],
      ]
      const shift = 360 * Math.round((anchor - location.longitude) / 360)
      const next: [[number, number], [number, number]] = [
        [area[0][0] + shift, area[0][1]],
        [area[1][0] + shift, area[1][1]],
      ]
      if (!combined) return next
      return [
        [Math.min(combined[0][0], next[0][0]), Math.min(combined[0][1], next[0][1])],
        [Math.max(combined[1][0], next[1][0]), Math.max(combined[1][1], next[1][1])],
      ]
    },
    undefined,
  )
}

const featuresFor = (
  location: MapLocation,
  zoom?: number,
): Feature<Point | Polygon, LocationProperties>[] => {
  assertLocation(location)
  if (location.precision === 'approximate') {
    if (
      location.radiusMeters === undefined ||
      !Number.isFinite(location.radiusMeters) ||
      location.radiusMeters <= 0
    ) {
      throw new RangeError(`Invalid approximate radius for ${location.id}.`)
    }
    return [
      areaFitsInsideMarker(location, location.radiusMeters, zoom)
        ? pointFeature(location, 'approximate')
        : areaFeature(location, location.radiusMeters, 'approximate'),
    ]
  }

  if (
    location.accuracyMeters !== undefined &&
    (!Number.isFinite(location.accuracyMeters) || location.accuracyMeters <= 0)
  ) {
    throw new RangeError(`Invalid accuracy for ${location.id}.`)
  }
  if (location.accuracyMeters !== undefined) {
    return [
      areaFitsInsideMarker(location, location.accuracyMeters, zoom)
        ? pointFeature(location, 'accuracy')
        : areaFeature(location, location.accuracyMeters, 'accuracy'),
    ]
  }

  return [pointFeature(location, 'position')]
}

export const createLocationFeatureCollection = (
  locations: readonly MapLocation[],
  zoom?: number,
): FeatureCollection<Point | Polygon, LocationProperties> => ({
  type: 'FeatureCollection',
  features: locations.flatMap((location) => featuresFor(location, zoom)),
})
