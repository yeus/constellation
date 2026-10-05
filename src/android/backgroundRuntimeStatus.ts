import type { AndroidBackgroundStatus } from './backgroundSharing.ts'
import type { BrowserLocationState } from '../location/browser.ts'
import type { NetworkDiagnostics, SharingRuntimeState } from '../sharing/sharingRuntime.ts'

export const backgroundRuntimeStatus = (
  state: SharingRuntimeState | undefined,
  diagnostics: NetworkDiagnostics,
  location: BrowserLocationState,
  failureMessage?: string,
): AndroidBackgroundStatus & { readonly endNotificationCount: number } => {
  const shares = state?.shares ?? []
  const endNotificationCount = state?.endNotifications.length ?? 0
  return {
    state:
      failureMessage !== undefined
        ? 'error'
        : shares.length
          ? 'sharing'
          : state?.peerStatus === 'error'
            ? 'error'
            : endNotificationCount
              ? 'stopped'
              : 'starting',
    endNotificationCount,
    peerStatus: state?.peerStatus ?? diagnostics.peerStatus,
    diagnostics,
    shares,
    returnOffers: state?.returnOffers ?? [],
    approvedReturnLinks: state?.approvedReturnLinks ?? [],
    oldSharing: state?.oldSharing ?? [],
    location,
    message: failureMessage ?? state?.message ?? '',
  }
}
