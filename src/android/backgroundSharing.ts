import { z } from 'zod'
import { SharingBehavior } from '../sharing/sharingBehavior.ts'
import type { PeerHistoryProtection } from '../sharing/peerHistory.ts'
import { DeviceComparison } from '../sharing/deviceComparison.ts'
import type { BrowserLocationState } from '../location/browser.ts'
import { shareExpiryFor, type ShareDraft, type SharePauseReason } from '../shareDraft.ts'
import type { PrivateState } from '../sharing/privateStore.ts'
import type { ShareSummary } from '../sharing/sharingRuntime.ts'
import type { NetworkDiagnostics } from '../sharing/sharingRuntime.ts'
import { StoppedViewerRecord } from '../sharing/privateStore.ts'
import { PeerNamePreference } from '../sharing/peerNames.ts'
import { parseShareInvitation, verifyReturnOwner } from '../sharing/shareLink.ts'

export const AndroidSharingSetup = z.object({
  behavior: SharingBehavior.nullable(),
  hasShares: z.boolean(),
  permissions: z.object({
    location: z.boolean(),
    background: z.boolean(),
    notifications: z.boolean(),
    servicesEnabled: z.boolean(),
  }),
})
export type AndroidSharingSetup = z.infer<typeof AndroidSharingSetup>

export interface AndroidBackgroundStatus {
  readonly deviceComparisons?: readonly DeviceComparison[]
  readonly sharingBehavior?: SharingBehavior
  readonly paused: boolean
  readonly state: 'starting' | 'sharing' | 'paused' | 'stopped' | 'error'
  readonly peerStatus?: 'offline' | 'connecting' | 'online' | 'error'
  readonly diagnostics?: NetworkDiagnostics
  readonly shares: readonly ShareSummary[]
  readonly returnOffers?: readonly {
    shareId: string
    viewerFingerprint: string
    ownerPeerId: string
    url: string
  }[]
  readonly approvedReturnLinks?: readonly string[]
  readonly peerNamePreferences?: readonly PeerNamePreference[]
  readonly pendingViewerApprovals?: readonly {
    shareId: string
    peerId: string
    fingerprint: string
    requestedAt: number
  }[]
  readonly oldSharing?: readonly {
    shareId: string
    peerId?: string
    name?: string
    endedAt: number
    reason: 'revoked' | 'expired'
  }[]
  readonly stoppedViewers?: readonly StoppedViewerRecord[]
  readonly location: BrowserLocationState
  readonly message: string
  readonly pauseReason?: SharePauseReason
  readonly sampling?: 'balanced' | 'saver'
}

interface AndroidBackgroundSharingDependencies {
  readonly isAndroid: boolean
  readonly now: () => number
  readonly preparePermissions?: (publication: ShareDraft['publication']) => Promise<void>
  readonly invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

const isLocationState = (value: unknown): value is BrowserLocationState => {
  if (!value || typeof value !== 'object' || !('status' in value)) return false
  return [
    'permission-required',
    'acquiring',
    'live',
    'delayed',
    'stale',
    'denied',
    'unavailable',
    'error',
  ].includes(String(value.status))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

const isOptionalArray = (value: unknown, guard: (entry: unknown) => boolean): boolean =>
  value === undefined || (Array.isArray(value) && value.every(guard))

const isString = (value: unknown): value is string => typeof value === 'string'

const isShareSummary = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return (
    typeof value.shareId === 'string' &&
    typeof value.url === 'string' &&
    ['exact', 'approximate', 'very-coarse'].includes(String(value.precision)) &&
    (value.expiresAt === null || typeof value.expiresAt === 'number') &&
    typeof value.viewerCount === 'number'
  )
}

const isReturnOffer = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return (
    typeof value.shareId === 'string' &&
    typeof value.viewerFingerprint === 'string' &&
    typeof value.ownerPeerId === 'string' &&
    typeof value.url === 'string'
  )
}

const isPendingViewerApproval = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return (
    typeof value.shareId === 'string' &&
    typeof value.peerId === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.requestedAt === 'number'
  )
}

const isOldShare = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  return (
    typeof value.shareId === 'string' &&
    (value.peerId === undefined || typeof value.peerId === 'string') &&
    typeof value.endedAt === 'number' &&
    ['revoked', 'expired'].includes(String(value.reason))
  )
}

const hasValidShares = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isShareSummary)

const hasValidStatusFields = (candidate: Partial<AndroidBackgroundStatus>): boolean =>
  !['starting', 'sharing', 'paused', 'stopped', 'error'].includes(String(candidate.state)) ||
  (candidate.paused !== undefined && typeof candidate.paused !== 'boolean') ||
  !isLocationState(candidate.location) ||
  !hasValidShares(candidate.shares) ||
  typeof candidate.message !== 'string' ||
  (candidate.sharingBehavior !== undefined &&
    !SharingBehavior.safeParse(candidate.sharingBehavior).success) ||
  (candidate.peerStatus !== undefined &&
    !['offline', 'connecting', 'online', 'error'].includes(candidate.peerStatus)) ||
  (candidate.pauseReason !== undefined &&
    !['metered', 'data-saver'].includes(candidate.pauseReason)) ||
  (candidate.sampling !== undefined && !['balanced', 'saver'].includes(candidate.sampling)) ||
  !isOptionalArray(candidate.returnOffers, isReturnOffer) ||
  !isOptionalArray(candidate.approvedReturnLinks, isString) ||
  !isOptionalArray(candidate.pendingViewerApprovals, isPendingViewerApproval) ||
  !isOptionalArray(candidate.oldSharing, isOldShare) ||
  (candidate.deviceComparisons !== undefined &&
    !DeviceComparison.array().max(256).safeParse(candidate.deviceComparisons).success) ||
  (candidate.stoppedViewers !== undefined &&
    !StoppedViewerRecord.array().max(128).safeParse(candidate.stoppedViewers).success)

const parseStatus = (value: unknown): AndroidBackgroundStatus => {
  if (!isRecord(value)) throw new Error('Invalid background sharing status.')
  const candidate = value as Partial<AndroidBackgroundStatus>
  if (hasValidStatusFields(candidate)) throw new Error('Invalid background sharing status.')
  if (
    candidate.peerNamePreferences !== undefined &&
    !PeerNamePreference.array().max(1_024).safeParse(candidate.peerNamePreferences).success
  ) {
    throw new Error('Invalid background name preferences.')
  }
  return { ...candidate, paused: candidate.paused === true } as AndroidBackgroundStatus
}

interface AndroidBackgroundSharing {
  start: (
    draft: ShareDraft,
    shareBaseUrl: string,
    visible: boolean,
  ) => Promise<AndroidBackgroundStatus>
  status: () => Promise<AndroidBackgroundStatus>
  stop: (shareId: string) => Promise<AndroidBackgroundStatus>
  setVisible: (visible: boolean) => Promise<void>
  setPaused: (paused: boolean) => Promise<AndroidBackgroundStatus>
  approveReturnLink: (shareId: string) => Promise<void>
  deviceComparison: (
    shareId: string,
    challenge: string,
    action: 'confirm' | 'cancel',
  ) => Promise<AndroidBackgroundStatus>
  approveViewer: (shareId: string, peerId: string) => Promise<AndroidBackgroundStatus>
  dismissReturnOffer: (shareId: string, fingerprint: string) => Promise<void>
  dismissStoppedViewer: (shareId: string, peerId: string) => Promise<void>
  replaceBackgroundOwner: (
    shareId: string,
    sourcePeerId: string,
    ownerPeerId: string,
    ownerProof: string,
    binding:
      | { readonly mode: 'source' }
      | { readonly mode: 'recipient'; readonly recipientPeerId: string },
  ) => Promise<AndroidBackgroundStatus>
  importSourceState: (state: PrivateState) => Promise<void>
  setViewerName: (
    shareId: string,
    fingerprint: string,
    name: string,
  ) => Promise<AndroidBackgroundStatus>
  blockViewer: (shareId: string, fingerprint: string) => Promise<AndroidBackgroundStatus>
  setup: () => Promise<AndroidSharingSetup>
  enablePermissions: () => Promise<AndroidSharingSetup>
  setSharingBehavior: (behavior: SharingBehavior) => Promise<AndroidBackgroundStatus>
  clearOldPeers: (protection: PeerHistoryProtection) => Promise<AndroidBackgroundStatus>
  adoptPeerName: (peerId: string, name: string) => Promise<AndroidBackgroundStatus>
  setPeerNamePreferences: (
    peerId: string,
    associateNames: boolean,
    sharedName: string | null,
  ) => Promise<AndroidBackgroundStatus>
}

const invokeStatus = async (
  dependencies: AndroidBackgroundSharingDependencies,
  command: string,
  args?: Record<string, unknown>,
): Promise<AndroidBackgroundStatus> => parseStatus(await dependencies.invoke(command, args))

const createStatusReader = (
  dependencies: AndroidBackgroundSharingDependencies,
): (() => Promise<AndroidBackgroundStatus>) => {
  let pendingStatus: Promise<AndroidBackgroundStatus> | undefined
  return () => {
    if (!pendingStatus) {
      pendingStatus = dependencies
        .invoke('android_background_share_status')
        .then(parseStatus)
        .finally(() => {
          pendingStatus = undefined
        })
    }
    return pendingStatus
  }
}

const createStartAction = (
  dependencies: AndroidBackgroundSharingDependencies,
): AndroidBackgroundSharing['start'] => {
  return async (draft, shareBaseUrl, visible) => {
    await dependencies.preparePermissions?.(draft.publication)
    return parseStatus(
      await dependencies.invoke('android_start_background_share', {
        request: {
          precision: draft.precision,
          viewerCapacity: draft.viewerCapacity,
          requireViewerApproval: draft.requireViewerApproval !== false,
          name: draft.name,
          publication: draft.publication,
          battery: draft.battery,
          network: draft.network,
          visible,
          expiresAt: shareExpiryFor(draft, dependencies.now()),
          shareBaseUrl,
        },
      }),
    )
  }
}

const createVisibilityActions = (dependencies: AndroidBackgroundSharingDependencies) => ({
  setVisible: async (visible: boolean) => {
    await dependencies.invoke('android_set_background_visibility', { visible })
  },
  setPaused: async (paused: boolean) =>
    invokeStatusAfter(dependencies, 'android_set_background_paused', { paused }),
})

const invokeStatusAfter = async (
  dependencies: AndroidBackgroundSharingDependencies,
  command: string,
  args: Record<string, unknown>,
): Promise<AndroidBackgroundStatus> => {
  await dependencies.invoke(command, args)
  return invokeStatus(dependencies, 'android_background_share_status')
}

const createReturnActions = (dependencies: AndroidBackgroundSharingDependencies) => ({
  approveReturnLink: async (shareId: string) => {
    await dependencies.invoke('android_approve_background_return_link', { shareId })
  },
  deviceComparison: async (shareId: string, challenge: string, action: 'confirm' | 'cancel') =>
    invokeStatusAfter(dependencies, 'android_background_device_comparison', {
      request: JSON.stringify({ shareId, challenge, action }),
    }),
  approveViewer: async (shareId: string, peerId: string) =>
    invokeStatusAfter(dependencies, 'android_approve_background_viewer', { shareId, peerId }),
  dismissReturnOffer: async (shareId: string, fingerprint: string) => {
    await dependencies.invoke('android_dismiss_background_return_offer', { shareId, fingerprint })
  },
  dismissStoppedViewer: async (shareId: string, peerId: string) => {
    await dependencies.invoke('android_dismiss_background_stopped_viewer', { shareId, peerId })
  },
})

const createOwnerHandoffAction = (
  dependencies: AndroidBackgroundSharingDependencies,
): AndroidBackgroundSharing['replaceBackgroundOwner'] => {
  return async (shareId, sourcePeerId, ownerPeerId, ownerProof, binding) => {
    try {
      await dependencies.invoke('android_replace_background_owner', {
        request: JSON.stringify({
          shareId,
          sourcePeerId,
          ownerPeerId,
          ownerProof,
          mode: binding.mode,
          ...(binding.mode === 'recipient' ? { recipientPeerId: binding.recipientPeerId } : {}),
        }),
      })
      return await invokeStatus(dependencies, 'android_background_share_status')
    } catch (error) {
      // A timed-out native command may have persisted successfully before its
      // callback was lost. Read back the atomic signed owner handoff rather
      // than revoking a correctly created share.
      try {
        const current = await invokeStatus(dependencies, 'android_background_share_status')
        const link = current.shares.find((share) => share.shareId === shareId)
        if (link) {
          const capability = parseShareInvitation(link.url)
          if (
            capability.sourcePeerId === sourcePeerId &&
            capability.ownerPeerId === ownerPeerId &&
            capability.ownerProof === ownerProof &&
            (await verifyReturnOwner(capability, ownerPeerId))
          ) {
            return current
          }
        }
      } catch {
        // Keep the original native error when readback is unavailable or invalid.
      }
      throw error
    }
  }
}

const createViewerActions = (dependencies: AndroidBackgroundSharingDependencies) => ({
  importSourceState: async (state: PrivateState) => {
    await dependencies.invoke('android_import_source_state', { state: JSON.stringify(state) })
  },
  setViewerName: async (shareId: string, fingerprint: string, name: string) =>
    invokeStatus(dependencies, 'android_set_background_viewer_name', {
      shareId,
      fingerprint,
      name,
    }),
  blockViewer: async (shareId: string, fingerprint: string) =>
    invokeStatus(dependencies, 'android_block_background_viewer', { shareId, fingerprint }),
})

const createSetupActions = (dependencies: AndroidBackgroundSharingDependencies) => ({
  setup: async () => AndroidSharingSetup.parse(await dependencies.invoke('android_sharing_setup')),
  enablePermissions: async () =>
    AndroidSharingSetup.parse(await dependencies.invoke('android_enable_sharing_permissions')),
  setSharingBehavior: async (behavior: SharingBehavior) =>
    invokeStatusAfter(dependencies, 'android_set_sharing_behavior', { behavior }),
  clearOldPeers: async (protection: PeerHistoryProtection) =>
    invokeStatusAfter(dependencies, 'android_clear_old_peers', { protection }),
  adoptPeerName: async (peerId: string, name: string) =>
    invokeStatusAfter(dependencies, 'android_adopt_background_peer_name', { peerId, name }),
  setPeerNamePreferences: async (
    peerId: string,
    associateNames: boolean,
    sharedName: string | null,
  ) =>
    invokeStatusAfter(dependencies, 'android_set_background_peer_names', {
      peerId,
      associateNames,
      sharedName,
    }),
})

export const createAndroidBackgroundSharing = (
  dependencies: AndroidBackgroundSharingDependencies,
): AndroidBackgroundSharing | undefined => {
  if (!dependencies.isAndroid) return undefined
  return {
    start: createStartAction(dependencies),
    status: createStatusReader(dependencies),
    stop: (shareId) => invokeStatus(dependencies, 'android_stop_background_share', { shareId }),
    ...createVisibilityActions(dependencies),
    ...createReturnActions(dependencies),
    replaceBackgroundOwner: createOwnerHandoffAction(dependencies),
    ...createViewerActions(dependencies),
    ...createSetupActions(dependencies),
  }
}
