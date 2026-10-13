import type { FollowSummary, ShareSummary } from './sharingRuntime.ts'

export interface PeerHistoryProtection {
  readonly peerIds: readonly string[]
  readonly shareIds: readonly string[]
}

export const protectActivePeerHistory = (
  shares: readonly Pick<ShareSummary, 'shareId' | 'recipientPeerId' | 'viewers'>[],
  following: readonly Pick<FollowSummary, 'shareId' | 'peerId' | 'status'>[],
): PeerHistoryProtection => {
  const activeFollowing = following.filter(
    (entry) => entry.status !== 'expired' && entry.status !== 'revoked',
  )
  return {
    shareIds: [
      ...new Set([
        ...shares.map((share) => share.shareId),
        ...activeFollowing.map((follow) => follow.shareId),
      ]),
    ],
    peerIds: [
      ...new Set([
        ...shares.flatMap((share) => [
          ...(share.recipientPeerId ? [share.recipientPeerId] : []),
          ...(share.viewers?.map((viewer) => viewer.peerId) ?? []),
        ]),
        ...activeFollowing.flatMap((follow) => (follow.peerId ? [follow.peerId] : [])),
      ]),
    ],
  }
}

export const canClearPeerRecord = (
  record: { readonly shareId: string; readonly peerId?: string; readonly cleared?: boolean },
  protection: PeerHistoryProtection,
): boolean =>
  !record.cleared &&
  !(record.peerId
    ? protection.peerIds.includes(record.peerId)
    : protection.shareIds.includes(record.shareId))

export const clearPeerHistory = <T extends { shareId: string; peerId?: string; cleared?: boolean }>(
  records: ReadonlyMap<string, T>,
  protection: PeerHistoryProtection,
): Map<string, T & { cleared?: boolean }> =>
  new Map(
    [...records].map(([key, record]) => [
      key,
      canClearPeerRecord(record, protection) ? { ...record, cleared: true } : record,
    ]),
  )

export const restoreFailedPeerHistoryClear = <T>(
  current: ReadonlyMap<string, T>,
  before: ReadonlyMap<string, T>,
  attempted: ReadonlyMap<string, T>,
): Map<string, T> =>
  new Map(
    [...current].map(([key, record]) => [
      key,
      record === attempted.get(key) && before.has(key) ? before.get(key)! : record,
    ]),
  )

export const hasEndedPeerShare = (
  records: Iterable<{ shareId: string }>,
  shareId: string,
): boolean => [...records].some((record) => record.shareId === shareId)
