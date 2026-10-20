import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'

import { backgroundSharePolicy } from './sharePolicy.ts'
import { parseShareInvitation } from './shareLink.ts'
import { base64UrlToBytes } from './encoding.ts'
import type { PrivateState } from './privateStore.ts'
import type { EndedSourceShare, SourceShare } from './sharingContracts.ts'
import type { SharingBehavior } from './sharingBehavior.ts'

export const restoredSourceShare = (
  record: PrivateState['shares'][number],
  behavior: SharingBehavior | undefined,
): SourceShare => {
  const capability = parseShareInvitation(record.url)
  return {
    capability,
    url: record.url,
    secret: base64UrlToBytes(capability.secret),
    ...(record.sourcePrivateKey
      ? {
          sourcePrivateKey: privateKeyFromProtobuf(base64UrlToBytes(record.sourcePrivateKey)),
        }
      : {}),
    precision: record.precision,
    capacity: record.capacity,
    requireViewerApproval: record.requireViewerApproval !== false,
    approvedPeerId: record.approvedPeerId,
    name: record.name,
    publication: behavior?.publication ?? record.publication,
    ...backgroundSharePolicy(
      behavior?.publication ?? record.publication,
      behavior?.battery ?? record.battery ?? 'balanced',
      behavior?.network ?? record.network ?? 'always',
    ),
    sessions: new Set(),
    viewerPeerIds: new Set(record.viewerPeerIds ?? []),
    redeemedNonces: new Set(),
    blockedPeerIds: new Set(record.blockedPeerIds ?? []),
    approximation: record.approximation,
  }
}

export const restoredEndedSourceShare = (
  record: NonNullable<PrivateState['endedShares']>[number],
): EndedSourceShare => {
  const capability = parseShareInvitation(record.url, 0)
  return {
    capability,
    capacity: record.capacity,
    approvedPeerId: record.approvedPeerId,
    url: record.url,
    publication: record.publication,
    reason: record.reason,
    endedAt: record.endedAt,
    ...(record.sourcePrivateKey
      ? {
          sourcePrivateKey: privateKeyFromProtobuf(base64UrlToBytes(record.sourcePrivateKey)),
        }
      : {}),
  }
}
