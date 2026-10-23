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

export const shouldAttemptTransportRecovery = (options: {
  readonly online: boolean
  readonly backgroundSources: number
  readonly now: number
  readonly stalled?: boolean
  readonly lastRecoveryAt: number | null
}): boolean =>
  options.online &&
  options.backgroundSources > 0 &&
  (options.lastRecoveryAt === null ||
    options.now - options.lastRecoveryAt >= (options.stalled ? 300_000 : 15_000))
