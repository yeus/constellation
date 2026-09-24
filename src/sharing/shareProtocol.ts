import { defineFrpServiceProtocol, mergeFrpProtocols } from '@taskyon/protocol'
import { sensorProtocolV1 } from '@taskyon/protocol/sensor'
import { z } from 'zod'

export const SHARE_STREAM_PROTOCOL = '/constellation/location-share/1.0.0' as const

export const shareProtocolV1 = defineFrpServiceProtocol({
  service: 'share',
  id: 'dev.constellation.share',
  version: '1',
  commands: {
    redeem: {
      request: z.object({
        shareId: z.string().min(16).max(64),
        viewerNonce: z.string().min(16).max(128),
        proof: z.string().min(32).max(128),
        label: z.string().trim().min(1).max(32).optional(),
      }),
      response: z.object({
        sessionId: z.string().min(16).max(64),
        expiresAt: z.number().int().positive().nullable(),
        precision: z.enum(['exact', 'approximate']),
        sourceName: z.string().max(32).optional(),
        heartbeatIntervalMs: z.number().int().min(5_000).max(60_000),
      }),
      defaultTimeoutMs: 10_000,
    },
    heartbeat: {
      request: z.object({ sessionId: z.string().min(16).max(64) }),
      response: z.object({ receivedAt: z.number().int().nonnegative() }),
      defaultTimeoutMs: 10_000,
    },
    leave: {
      request: z.object({ sessionId: z.string().min(16).max(64) }),
      defaultTimeoutMs: 5_000,
    },
  },
  streams: {
    sessions: {
      closed: z.object({
        sessionId: z.string().min(16).max(64),
        reason: z.enum(['expired', 'revoked', 'disconnected', 'error']),
      }),
    },
  },
})

export const constellationProtocolV1 = mergeFrpProtocols({
  id: 'dev.constellation.location-share',
  version: '1',
  base: sensorProtocolV1,
  extension: shareProtocolV1,
})
