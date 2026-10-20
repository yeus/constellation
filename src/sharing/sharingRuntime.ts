import type { BrowserLocationSource } from '../location/browser.ts'
import type { PrivateStateStore } from './privateStore.ts'
import type { SharingRuntime } from './sharingContracts.ts'
import { createSharingApi } from './sharingApi.ts'
import { createSharingContext } from './sharingContext.ts'

export { followStatusFor, savedFollowRecords } from './sharingProjection.ts'
export { acceptReturnShare } from './sharingReturn.ts'
export {
  FOLLOW_COLORS,
  appendSessionEvent,
  claimSingleRecipient,
  rememberRedeemedNonce,
  sessionSweepReason,
} from './sharingRuntimeHelpers.ts'
export { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
export type {
  FollowStatus,
  FollowSummary,
  NetworkDiagnostics,
  OldShareSummary,
  PeerStatus,
  SessionEvent,
  ShareSummary,
  SharingRuntime,
  SharingRuntimeState,
} from './sharingContracts.ts'

export const createSharingRuntime = (
  locationSource: BrowserLocationSource,
  shareBaseUrl = window.location.origin + window.location.pathname,
  store?: PrivateStateStore,
  returnShareReceiver: 'local' | 'external' = 'local',
): SharingRuntime => {
  const context = createSharingContext(locationSource, shareBaseUrl, store, returnShareReceiver)
  const runtime = createSharingApi(context)
  context.runtimeApi = runtime
  return runtime
}
