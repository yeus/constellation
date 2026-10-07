import {
  defineFrpServiceProtocol,
  mergeFrpProtocols,
  type ProtocolMessage,
} from '@taskyon/protocol'
import { sensorProtocolV1 } from '@taskyon/protocol/sensor'
import { z } from 'zod'

export const SHARE_STREAM_PROTOCOL = '/constellation/location-share/2.0.0' as const

export const shareProtocolV2 = defineFrpServiceProtocol({
  service: 'share',
  id: 'dev.constellation.share',
  version: '2',
  commands: {
    redeem: {
      request: z
        .object({
          shareId: z.string().min(16).max(64),
          viewerNonce: z.string().min(16).max(128),
          proof: z.string().min(32).max(128),
          label: z.string().trim().min(1).max(32).optional(),
        })
        .strict(),
      response: z.union([
        z
          .object({
            sessionId: z.string().min(16).max(64),
            expiresAt: z.number().int().positive().nullable(),
            precision: z.enum(['exact', 'approximate']),
            sourceName: z.string().max(32).optional(),
            heartbeatIntervalMs: z.number().int().min(5_000).max(60_000),
          })
          .strict(),
        z
          .object({
            ended: z.literal(true),
            reason: z.enum(['revoked', 'expired']),
            endedAt: z.number().int().positive(),
          })
          .strict(),
        z
          .object({
            approvalPending: z.literal(true),
            retryAfterMs: z.number().int().min(5_000).max(60_000),
          })
          .strict(),
        z.object({ accessDenied: z.literal(true) }).strict(),
      ]),
      defaultTimeoutMs: 10_000,
    },
    heartbeat: {
      request: z.object({ sessionId: z.string().min(16).max(64) }).strict(),
      response: z.object({ receivedAt: z.number().int().nonnegative() }).strict(),
      defaultTimeoutMs: 10_000,
    },
    leave: {
      request: z.object({ sessionId: z.string().min(16).max(64) }).strict(),
      defaultTimeoutMs: 5_000,
    },
    offerReturn: {
      request: z
        .object({
          sessionId: z.string().min(16).max(64),
          url: z.string().url().max(4_096),
          ownerPeerId: z.string().min(1).max(256),
        })
        .strict(),
      defaultTimeoutMs: 10_000,
    },
  },
  streams: {
    sessions: {
      closed: z
        .object({
          sessionId: z.string().min(16).max(64),
          reason: z.enum(['expired', 'revoked', 'disconnected', 'error']),
        })
        .strict(),
    },
  },
})

export const constellationProtocolV2 = mergeFrpProtocols({
  id: 'dev.constellation.location-share',
  version: '2',
  base: sensorProtocolV1,
  extension: shareProtocolV2,
})

export type ConstellationMessage = ProtocolMessage<typeof constellationProtocolV2>
export const parseConstellationMessage = (value: unknown): ConstellationMessage =>
  constellationProtocolV2.message.parse(value) as ConstellationMessage
