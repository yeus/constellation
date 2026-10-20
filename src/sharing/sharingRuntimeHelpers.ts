import type { ShareDraft } from '../shareDraft.ts'
import { bytesToBase64Url } from './encoding.ts'
import type { SessionEvent, SourceSession, SourceShare } from './sharingContracts.ts'

export const LOCATION_SENSOR_ID = 'location'
export const DESCRIPTOR_REVISION = 'constellation-location-v1'
export const HEARTBEAT_INTERVAL_MS = 10_000
export const HEARTBEAT_TIMEOUT_MS = 35_000
export const MAX_ACTIVE_SESSIONS = 128
export const MAX_REMEMBERED_VIEWER_PEERS = MAX_ACTIVE_SESSIONS
export const MAX_REDEEMED_NONCES_PER_SHARE = 1_024
export const MAX_PENDING_VIEWER_APPROVALS_PER_SHARE = 128

export const sessionSweepReason = (
  expiresAt: number | null,
  lastHeartbeatAt: number,
  now: number,
): 'expired' | 'heartbeat-timeout' | undefined => {
  if (expiresAt !== null && now >= expiresAt) return 'expired'
  if (now - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) return 'heartbeat-timeout'
  return undefined
}

export const FOLLOW_COLORS = ['#438ec9', '#8a6fc9', '#289a82', '#c0709a'] as const

export const appendSessionEvent = (
  events: readonly SessionEvent[],
  event: SessionEvent,
): readonly SessionEvent[] => [...events, event].slice(-32)

export const claimSingleRecipient = async (
  share: { approvedPeerId?: string; claimPending?: boolean },
  peerId: string,
  persistClaim: () => Promise<void>,
): Promise<'claimed' | 'pending' | 'denied'> => {
  if (share.approvedPeerId && share.approvedPeerId !== peerId) return 'denied'
  if (share.claimPending) return 'pending'
  if (share.approvedPeerId === peerId) return 'claimed'
  share.approvedPeerId = peerId
  share.claimPending = true
  try {
    await persistClaim()
    return 'claimed'
  } catch (error) {
    share.approvedPeerId = undefined
    throw error
  } finally {
    share.claimPending = false
  }
}

export const viewerFingerprint = async (shareId: string, peerId: string): Promise<string> => {
  const input = new TextEncoder().encode(`${shareId}:${peerId}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return bytesToBase64Url(digest.slice(0, 6))
}

export const randomToken = (bytes = 16): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))

export const capacityFor = (draft: ShareDraft): number =>
  Math.min(
    draft.viewerCapacity === 'unlimited' ? MAX_ACTIVE_SESSIONS : draft.viewerCapacity,
    MAX_ACTIVE_SESSIONS,
  )

export const rememberRedeemedNonce = (
  nonces: Set<string>,
  nonce: string,
  maximum = MAX_REDEEMED_NONCES_PER_SHARE,
): void => {
  nonces.add(nonce)
  while (nonces.size > maximum) {
    const oldest = nonces.values().next().value
    if (oldest === undefined) return
    nonces.delete(oldest)
  }
}

export const requireAuthorized = (session: SourceSession, share: SourceShare | undefined): SourceShare => {
  if (!share || !session.sessionId) throw new Error('Share access denied.')
  if (share.capability.expiresAt !== null && Date.now() >= share.capability.expiresAt) {
    throw new Error('Share access denied.')
  }
  return share
}
