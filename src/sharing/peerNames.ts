import { defineFrpServiceProtocol } from '@taskyon/protocol'
import { z } from 'zod'

export const PEER_NAMES_PROTOCOL = '/constellation/peer-names/1.0.0'

export const PeerNamePreference = z
  .object({
    peerId: z.string().min(1).max(256),
    associateNames: z.boolean(),
    nickname: z.string().trim().max(32).optional(),
    sharedName: z.string().trim().min(1).max(32).nullable(),
    receivedName: z.string().trim().min(1).max(32).nullable(),
    acceptedName: z.string().trim().min(1).max(32).nullable().optional(),
  })
  .strict()
export type PeerNamePreference = z.output<typeof PeerNamePreference>

export const displayedPeerName = (
  preference: PeerNamePreference | undefined,
  privateNickname: string | undefined,
  fallback: string,
): string =>
  (preference?.associateNames ? preference.nickname : undefined) ||
  privateNickname ||
  (preference?.acceptedName !== undefined ? preference.acceptedName : preference?.receivedName) ||
  fallback

export const advertisedPeerName = (
  preference: PeerNamePreference | undefined,
  linkName?: string,
): string | undefined => preference?.receivedName || linkName

// Keep the last advertisement available for explicit adoption without renaming a peer.
export const receiveAdvertisedName = (
  previous: PeerNamePreference,
  receivedName: string | null,
  currentName?: string,
): PeerNamePreference =>
  PeerNamePreference.parse({
    ...previous,
    receivedName,
    acceptedName: previous.acceptedName ?? previous.receivedName ?? currentName ?? receivedName,
  })

export const nameAfterContact = (
  previous: { localName: string; usesPrivateName?: boolean; approvalPending?: boolean } | undefined,
  advertisedName: string | undefined,
  requestedName: string | undefined,
  fallback: string,
): string => {
  if (previous?.usesPrivateName) return previous.localName
  if (previous && !previous.approvalPending && previous.localName !== fallback)
    return previous.localName
  return requestedName?.trim() || advertisedName || previous?.localName || fallback
}

// Negotiate separately so old, strict location-stream decoders never receive
// unknown profile messages. Authorization is an existing live location session.
export const peerNamesProtocol = defineFrpServiceProtocol({
  service: 'peerNames',
  id: 'dev.constellation.peer-names',
  version: '1',
  commands: {
    exchange: {
      request: z
        .object({
          shareId: z.string().min(16).max(64),
          sessionId: z.string().min(16).max(64),
          displayName: z.string().trim().min(1).max(32).nullable(),
        })
        .strict(),
      response: z.object({ displayName: z.string().trim().min(1).max(32).nullable() }).strict(),
      defaultTimeoutMs: 5_000,
    },
  },
  streams: {
    profile: {
      changed: z.object({ displayName: z.string().trim().min(1).max(32).nullable() }).strict(),
    },
  },
})
