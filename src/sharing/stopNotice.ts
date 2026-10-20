import type { StoppedViewerRecord, PendingStopNotice } from './privateStore.ts'
import { createStopNoticeProof } from './shareAuth.ts'
import { parseShareInvitation } from './shareLink.ts'
import { base64UrlToBytes } from './encoding.ts'

export const STOP_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const recentStopEvents = (previous: StoppedViewerRecord | undefined) =>
  previous
    ? [
        ...(previous.recentEvents ?? []),
        {
          eventId: previous.eventId,
          recordedAt: previous.recordedAt,
        },
      ].slice(-16)
    : undefined

const rememberStoppedViewer = (
  history: Map<string, StoppedViewerRecord>,
  record: Omit<StoppedViewerRecord, 'recordedAt' | 'dismissed'>,
  recentEvents: StoppedViewerRecord['recentEvents'],
  now: number,
) => {
  const key = JSON.stringify([record.shareId, record.peerId])
  history.delete(key)
  history.set(key, {
    shareId: record.shareId,
    peerId: record.peerId,
    eventId: record.eventId,
    recordedAt: now,
    ...(recentEvents ? { recentEvents } : {}),
  })
  while (history.size > 128) {
    const oldest = history.keys().next().value
    if (oldest) history.delete(oldest)
  }
}

const restoreStoppedHistory = (
  history: Map<string, StoppedViewerRecord>,
  before: ReadonlyMap<string, StoppedViewerRecord>,
) => {
  history.clear()
  for (const [key, entry] of before) history.set(key, entry)
}

export const recordStoppedViewer = async (
  history: Map<string, StoppedViewerRecord>,
  record: Omit<StoppedViewerRecord, 'recordedAt' | 'dismissed'>,
  persist: () => Promise<void>,
  now: number = Date.now(),
): Promise<number> => {
  const key = JSON.stringify([record.shareId, record.peerId])
  const previous = history.get(key)
  if (previous?.eventId === record.eventId) return previous.recordedAt
  const seen = previous?.recentEvents?.find(({ eventId }) => eventId === record.eventId)
  if (seen) return seen.recordedAt
  const before = new Map(history)
  rememberStoppedViewer(history, record, recentStopEvents(previous), now)
  try {
    await persist()
  } catch (error) {
    restoreStoppedHistory(history, before)
    throw error
  }
  return now
}

export const rotatePendingNotice = <T>(queue: Map<string, T>, id: string): void => {
  const pending = queue.get(id)
  if (!pending) return
  queue.delete(id)
  queue.set(id, pending)
}

/** An unfollow can be reported even if the original location was only a preview. */
export const shouldQueueStopNotice = (
  protectedStoreAvailable: boolean,
  privateStateAvailable: boolean,
): boolean => protectedStoreAvailable && privateStateAvailable

/** Persist before dispatch; never block local navigation on network delivery. */
export const dispatchStopDelivery = (
  deliver: () => Promise<boolean>,
  settle: (confirmed: boolean) => Promise<void>,
): void => {
  void Promise.resolve()
    .then(deliver)
    .catch(() => false)
    .then(settle)
    .catch(() => undefined)
}

/** Derive a non-redeemable stop capability; never retain the original share secret. */
export const preparePendingStopNotice = async (
  invitationUrl: string,
  eventId: string,
  viewerPeerId: string,
  queuedAt: number = Date.now(),
): Promise<PendingStopNotice> => {
  const invitation = parseShareInvitation(invitationUrl, 0)
  const proof = await createStopNoticeProof(base64UrlToBytes(invitation.secret), {
    shareId: invitation.shareId,
    sourcePeerId: invitation.sourcePeerId,
    viewerPeerId,
    eventId,
  })
  return {
    shareId: invitation.shareId,
    sourcePeerId: invitation.sourcePeerId,
    viewerPeerId,
    addresses: invitation.addresses,
    proof,
    eventId,
    queuedAt,
  }
}
