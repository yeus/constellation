import type { ShareSummary } from '../sharing/sharingContracts.ts'

export const hasStalledDelivery = (
  shares: readonly {
    publication?: ShareSummary['publication']
    viewers?: readonly Pick<
      NonNullable<ShareSummary['viewers']>[number],
      'deliveryVerification' | 'pendingObservations' | 'pendingSince'
    >[]
  }[],
  now: number,
): boolean =>
  shares.some(
    (share) =>
      share.publication === 'background' &&
      share.viewers?.some(
        (viewer) =>
          viewer.deliveryVerification === 'supported' &&
          (viewer.pendingObservations ?? 0) > 0 &&
          viewer.pendingSince !== undefined &&
          now - viewer.pendingSince >= 90_000,
      ),
  )

export const shouldSignalIdleAfterShareUpdate = (
  previousShareCount: number,
  currentShareCount: number,
): boolean => previousShareCount > 0 && currentShareCount === 0

export const hasRecentAuthenticatedViewer = (
  shares: readonly {
    publication?: ShareSummary['publication']
    viewers?: readonly Pick<NonNullable<ShareSummary['viewers']>[number], 'lastSeenAt'>[]
  }[],
  now: number,
): boolean =>
  shares.some(
    (share) =>
      share.publication === 'background' &&
      share.viewers?.some(
        (viewer) =>
          viewer.lastSeenAt !== undefined &&
          now >= viewer.lastSeenAt &&
          now - viewer.lastSeenAt < 45_000,
      ),
  )

export const shouldAttemptTransportRecovery = (options: {
  readonly online: boolean
  readonly backgroundSources: number
  readonly now: number
  readonly stalled?: boolean
  readonly recentlyActive?: boolean
  readonly lastRecoveryAt: number | null
}): boolean =>
  options.online &&
  options.backgroundSources > 0 &&
  (!options.recentlyActive || options.stalled === true) &&
  (options.lastRecoveryAt === null ||
    options.now - options.lastRecoveryAt >= (options.stalled ? 300_000 : 15_000))

export const receiverRecoveryOutcome = (
  follows: readonly { readonly connected: boolean }[],
): 'connected' | 'pending' =>
  follows.length > 0 && follows.every(({ connected }) => connected) ? 'connected' : 'pending'

// A network handoff can leave a viewer's transport appearing connected even
// though it no longer carries data. Force one re-dial after a confirmed handoff;
// otherwise recover only disconnected saved follows. Never spin on every tick.
export const shouldAttemptReceiverRecovery = (options: {
  readonly online: boolean
  readonly savedFollows: number
  readonly disconnected: boolean
  readonly force: boolean
  readonly now: number
  readonly lastRecoveryAt: number | null
}): boolean =>
  options.online &&
  options.savedFollows > 0 &&
  (options.disconnected || options.force) &&
  (options.lastRecoveryAt === null || options.now - options.lastRecoveryAt >= 120_000)
