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

const parseStatus = (value: unknown): AndroidBackgroundStatus => {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid background sharing status.')
  }
  const candidate = value as Partial<AndroidBackgroundStatus>
  if (
    !['starting', 'sharing', 'paused', 'stopped', 'error'].includes(String(candidate.state)) ||
    !isLocationState(candidate.location) ||
    !Array.isArray(candidate.shares) ||
    candidate.shares.some(
      (share) =>
        !share ||
        typeof share.shareId !== 'string' ||
        typeof share.url !== 'string' ||
        !['exact', 'approximate', 'very-coarse'].includes(share.precision) ||
        (share.expiresAt !== null && typeof share.expiresAt !== 'number') ||
        typeof share.viewerCount !== 'number',
    ) ||
    typeof candidate.message !== 'string' ||
    (candidate.sharingBehavior !== undefined &&
      !SharingBehavior.safeParse(candidate.sharingBehavior).success) ||
    (candidate.peerStatus !== undefined &&
      !['offline', 'connecting', 'online', 'error'].includes(candidate.peerStatus)) ||
    (candidate.pauseReason !== undefined &&
      !['metered', 'data-saver'].includes(candidate.pauseReason)) ||
    (candidate.sampling !== undefined && !['balanced', 'saver'].includes(candidate.sampling)) ||
    (candidate.returnOffers !== undefined &&
      (!Array.isArray(candidate.returnOffers) ||
        candidate.returnOffers.some(
          (offer) =>
            !offer ||
            typeof offer.shareId !== 'string' ||
            typeof offer.viewerFingerprint !== 'string' ||
            typeof offer.ownerPeerId !== 'string' ||
            typeof offer.url !== 'string',
        ))) ||
    (candidate.approvedReturnLinks !== undefined &&
      (!Array.isArray(candidate.approvedReturnLinks) ||
        candidate.approvedReturnLinks.some((shareId) => typeof shareId !== 'string'))) ||
    (candidate.pendingViewerApprovals !== undefined &&
      (!Array.isArray(candidate.pendingViewerApprovals) ||
        candidate.pendingViewerApprovals.some(
          (request) =>
            !request ||
            typeof request.shareId !== 'string' ||
            typeof request.peerId !== 'string' ||
            typeof request.fingerprint !== 'string' ||
            typeof request.requestedAt !== 'number',
        ))) ||
    (candidate.oldSharing !== undefined &&
      (!Array.isArray(candidate.oldSharing) ||
        candidate.oldSharing.some(
          (record) =>
            !record ||
            typeof record.shareId !== 'string' ||
            (record.peerId !== undefined && typeof record.peerId !== 'string') ||
            typeof record.endedAt !== 'number' ||
            !['revoked', 'expired'].includes(record.reason),
        ))) ||
    (candidate.deviceComparisons !== undefined &&
      !DeviceComparison.array().max(256).safeParse(candidate.deviceComparisons).success) ||
    // Validate native status before presenting persisted stop notices.
    (candidate.stoppedViewers !== undefined &&
      !StoppedViewerRecord.array().max(128).safeParse(candidate.stoppedViewers).success)
  ) {
    throw new Error('Invalid background sharing status.')
  }
  if (
    candidate.peerNamePreferences !== undefined &&
    !PeerNamePreference.array().max(1_024).safeParse(candidate.peerNamePreferences).success
  ) {
    throw new Error('Invalid background name preferences.')
  }
  return candidate as AndroidBackgroundStatus
}

export const createAndroidBackgroundSharing = (
  dependencies: AndroidBackgroundSharingDependencies,
):
  | {
      start: (
        draft: ShareDraft,
        shareBaseUrl: string,
        visible: boolean,
      ) => Promise<AndroidBackgroundStatus>
      status: () => Promise<AndroidBackgroundStatus>
      stop: (shareId: string) => Promise<AndroidBackgroundStatus>
      setVisible: (visible: boolean) => Promise<void>
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
  | undefined => {
  if (!dependencies.isAndroid) return undefined
  let pendingStatus: Promise<AndroidBackgroundStatus> | undefined
  const status = (): Promise<AndroidBackgroundStatus> => {
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
  return {
    start: async (draft, shareBaseUrl, visible) => {
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
    },
    status,
    stop: async (shareId) =>
      parseStatus(await dependencies.invoke('android_stop_background_share', { shareId })),
    setVisible: async (visible) => {
      await dependencies.invoke('android_set_background_visibility', { visible })
    },
    approveReturnLink: async (shareId) => {
      await dependencies.invoke('android_approve_background_return_link', { shareId })
    },
    deviceComparison: async (shareId, challenge, action) => {
      await dependencies.invoke('android_background_device_comparison', {
        request: JSON.stringify({ shareId, challenge, action }),
      })
      return parseStatus(await dependencies.invoke('android_background_share_status'))
    },
    approveViewer: async (shareId, peerId) => {
      await dependencies.invoke('android_approve_background_viewer', { shareId, peerId })
      return parseStatus(await dependencies.invoke('android_background_share_status'))
    },
    dismissReturnOffer: async (shareId, fingerprint) => {
      await dependencies.invoke('android_dismiss_background_return_offer', {
        shareId,
        fingerprint,
      })
    },
    dismissStoppedViewer: async (shareId, peerId) => {
      await dependencies.invoke('android_dismiss_background_stopped_viewer', { shareId, peerId })
    },
    replaceBackgroundOwner: async (shareId, sourcePeerId, ownerPeerId, ownerProof, binding) => {
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
        return parseStatus(await dependencies.invoke('android_background_share_status'))
      } catch (error) {
        // A timed-out native command may have persisted successfully before its
        // callback was lost. Read back the atomic signed owner handoff rather
        // than revoking a correctly created share.
        try {
          const current = parseStatus(await dependencies.invoke('android_background_share_status'))
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
    },
    importSourceState: async (state) => {
      await dependencies.invoke('android_import_source_state', {
        state: JSON.stringify(state),
      })
    },
    setViewerName: async (shareId, fingerprint, name) =>
      parseStatus(
        await dependencies.invoke('android_set_background_viewer_name', {
          shareId,
          fingerprint,
          name,
        }),
      ),
    blockViewer: async (shareId, fingerprint) =>
      parseStatus(
        await dependencies.invoke('android_block_background_viewer', { shareId, fingerprint }),
      ),
    setup: async () =>
      AndroidSharingSetup.parse(await dependencies.invoke('android_sharing_setup')),
    enablePermissions: async () =>
      AndroidSharingSetup.parse(await dependencies.invoke('android_enable_sharing_permissions')),
    setSharingBehavior: async (behavior) => {
      await dependencies.invoke('android_set_sharing_behavior', { behavior })
      return parseStatus(await dependencies.invoke('android_background_share_status'))
    },
    clearOldPeers: async (protection) => {
      await dependencies.invoke('android_clear_old_peers', { protection })
      return parseStatus(await dependencies.invoke('android_background_share_status'))
    },
    adoptPeerName: async (peerId, name) => {
      await dependencies.invoke('android_adopt_background_peer_name', { peerId, name })
      return parseStatus(await dependencies.invoke('android_background_share_status'))
    },
    setPeerNamePreferences: async (peerId, associateNames, sharedName) => {
      await dependencies.invoke('android_set_background_peer_names', {
        peerId,
        associateNames,
        sharedName,
      })
      return parseStatus(await dependencies.invoke('android_background_share_status'))
    },
  }
}
