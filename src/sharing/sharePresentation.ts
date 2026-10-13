import type { ShareSummary } from './sharingRuntime.ts'

// Android service presence is authoritative when a source share is handed over.
export const mergeShareSummaries = (
  foreground: readonly ShareSummary[],
  background: readonly ShareSummary[],
): ShareSummary[] => [
  ...new Map([...foreground, ...background].map((share) => [share.shareId, share])).values(),
]

export interface ShareContactState {
  readonly shares: readonly Pick<ShareSummary, 'shareId' | 'viewerCount' | 'viewers'>[]
  readonly pendingViewerApprovals?: readonly { shareId: string; peerId: string }[]
}

export const hasNewShareRecipient = (
  shareId: string,
  previous: ShareContactState,
  next: ShareContactState,
): boolean => {
  const newRequest = next.pendingViewerApprovals?.some(
    (request) =>
      request.shareId === shareId &&
      !previous.pendingViewerApprovals?.some(
        (old) => old.shareId === shareId && old.peerId === request.peerId,
      ),
  )
  if (newRequest) return true
  const currentShare = next.shares.find((share) => share.shareId === shareId)
  if (!currentShare || currentShare.viewerCount === 0) return false
  const previousShare = previous.shares.find((share) => share.shareId === shareId)
  if (currentShare.viewerCount > (previousShare?.viewerCount ?? 0)) return true
  return (
    currentShare.viewers?.some(
      (viewer) =>
        !previousShare?.viewers?.some(
          (old) => old.peerId === viewer.peerId && old.fingerprint === viewer.fingerprint,
        ),
    ) ?? false
  )
}
