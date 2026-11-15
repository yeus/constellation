import type { LocationObservationV1 } from '../location/locationObservation.ts'

/** Only the disclosed geometry and replay-ordering metadata are needed after reconnect/restart. */
export const minimalLastKnownObservation = (
  observation: LocationObservationV1,
): LocationObservationV1 => ({
  profile: observation.profile,
  sourceId: observation.sourceId,
  precision: observation.precision,
  sequence: observation.sequence,
  capturedAt: observation.capturedAt,
  expiresAt: observation.expiresAt,
  latitude: observation.latitude,
  longitude: observation.longitude,
  accuracyMeters: observation.accuracyMeters,
})
