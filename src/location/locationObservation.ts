export const LOCATION_PROFILE_V1 = 'dev.constellation.location/v1' as const

export interface LocationObservationV1 {
  readonly profile: typeof LOCATION_PROFILE_V1
  readonly sourceId: string
  readonly precision: 'exact' | 'approximate'
  readonly sequence: number
  readonly capturedAt: number
  readonly expiresAt: number
  readonly latitude: number
  readonly longitude: number
  readonly accuracyMeters: number
  readonly altitudeMeters?: number
  readonly headingDegrees?: number
  readonly speedMps?: number
}

export const acceptNewerLocationObservation = (
  current: LocationObservationV1 | undefined,
  next: LocationObservationV1,
): boolean =>
  current === undefined || (next.sourceId === current.sourceId && next.sequence > current.sequence)

const requireFiniteNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number.`)
  }
  return value
}

const optionalFiniteNumber = (value: unknown, field: string): number | undefined =>
  value === undefined ? undefined : requireFiniteNumber(value, field)

const LOCATION_OBSERVATION_FIELDS = [
  'profile',
  'sourceId',
  'precision',
  'sequence',
  'capturedAt',
  'expiresAt',
  'latitude',
  'longitude',
  'accuracyMeters',
  'altitudeMeters',
  'headingDegrees',
  'speedMps',
] as const

export const parseLocationObservationV1 = (value: unknown): LocationObservationV1 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Location observation must be an object.')
  }
  const raw = value as Record<string, unknown>
  const unknownField = Object.keys(raw).find(
    (field) =>
      !LOCATION_OBSERVATION_FIELDS.includes(field as (typeof LOCATION_OBSERVATION_FIELDS)[number]),
  )
  if (unknownField) throw new TypeError(`Unknown location observation field: ${unknownField}.`)
  if (raw.profile !== LOCATION_PROFILE_V1) {
    throw new TypeError(`Unsupported location profile: ${String(raw.profile)}.`)
  }
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length < 1 || raw.sourceId.length > 128) {
    throw new RangeError('sourceId must contain between 1 and 128 characters.')
  }
  if (raw.precision !== 'exact' && raw.precision !== 'approximate') {
    throw new TypeError('precision must be exact or approximate.')
  }

  const sequence = requireFiniteNumber(raw.sequence, 'sequence')
  const capturedAt = requireFiniteNumber(raw.capturedAt, 'capturedAt')
  const expiresAt = requireFiniteNumber(raw.expiresAt, 'expiresAt')
  const latitude = requireFiniteNumber(raw.latitude, 'latitude')
  const longitude = requireFiniteNumber(raw.longitude, 'longitude')
  const accuracyMeters = requireFiniteNumber(raw.accuracyMeters, 'accuracyMeters')
  const altitudeMeters = optionalFiniteNumber(raw.altitudeMeters, 'altitudeMeters')
  const headingDegrees = optionalFiniteNumber(raw.headingDegrees, 'headingDegrees')
  const speedMps = optionalFiniteNumber(raw.speedMps, 'speedMps')

  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError('sequence must be a non-negative safe integer.')
  }
  if (!Number.isSafeInteger(capturedAt) || !Number.isSafeInteger(expiresAt)) {
    throw new RangeError('Observation timestamps must be integer milliseconds.')
  }
  if (expiresAt <= capturedAt) throw new RangeError('expiresAt must be later than capturedAt.')
  if (latitude < -90 || latitude > 90) throw new RangeError('latitude is out of range.')
  if (longitude < -180 || longitude > 180) throw new RangeError('longitude is out of range.')
  if (accuracyMeters <= 0) throw new RangeError('accuracyMeters must be positive.')
  if (headingDegrees !== undefined && (headingDegrees < 0 || headingDegrees >= 360)) {
    throw new RangeError('headingDegrees must be between 0 inclusive and 360 exclusive.')
  }
  if (speedMps !== undefined && speedMps < 0) {
    throw new RangeError('speedMps must be non-negative.')
  }

  return {
    profile: LOCATION_PROFILE_V1,
    sourceId: raw.sourceId,
    precision: raw.precision,
    sequence,
    capturedAt,
    expiresAt,
    latitude,
    longitude,
    accuracyMeters,
    ...(altitudeMeters === undefined ? {} : { altitudeMeters }),
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
    ...(speedMps === undefined ? {} : { speedMps }),
  }
}
