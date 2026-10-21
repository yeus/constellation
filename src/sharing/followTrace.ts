import { z } from 'zod'
import type { LocationObservationV1 } from '../location/locationObservation.ts'

export const FOLLOW_TRACE_RETENTION_MS = 24 * 60 * 60 * 1_000
export const MAX_FOLLOW_TRACE_EVENTS = 288

const Timestamp = z.number().int().nonnegative().finite()
export const FollowTraceEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('location'),
    receivedAt: Timestamp,
    capturedAt: Timestamp,
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMeters: z.number().finite().nonnegative(),
    precision: z.enum(['exact', 'approximate']),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('closed'),
    receivedAt: Timestamp,
    reason: z.enum(['expired', 'revoked', 'disconnected', 'error', 'cancelled']),
  }),
])
export type FollowTraceEvent = z.output<typeof FollowTraceEventSchema>

export const pruneFollowTrace = (
  events: readonly FollowTraceEvent[],
  now = Date.now(),
): FollowTraceEvent[] =>
  events
    .filter(
      (event) => event.receivedAt <= now && event.receivedAt >= now - FOLLOW_TRACE_RETENTION_MS,
    )
    .slice(-MAX_FOLLOW_TRACE_EVENTS)

export const appendFollowTrace = (
  existing: readonly FollowTraceEvent[],
  event:
    | { type: 'location'; observation: LocationObservationV1; receivedAt: number }
    | {
        type: 'closed'
        receivedAt: number
        reason: Extract<FollowTraceEvent, { type: 'closed' }>['reason']
      },
  now = Date.now(),
): FollowTraceEvent[] => {
  const recorded: FollowTraceEvent =
    event.type === 'location'
      ? {
          type: 'location',
          receivedAt: event.receivedAt,
          capturedAt: event.observation.capturedAt,
          latitude: event.observation.latitude,
          longitude: event.observation.longitude,
          accuracyMeters: event.observation.accuracyMeters,
          precision: event.observation.precision,
          sequence: event.observation.sequence,
        }
      : { type: 'closed', receivedAt: event.receivedAt, reason: event.reason }
  return pruneFollowTrace([...existing, recorded], now)
}
