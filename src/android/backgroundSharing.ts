import type { BrowserLocationState } from '../location/browser.ts'
import { shareExpiryFor, type ShareDraft, type SharePauseReason } from '../shareDraft.ts'
import type { PrivateState } from '../sharing/privateStore.ts'
import type { ShareSummary } from '../sharing/sharingRuntime.ts'
import type { NetworkDiagnostics } from '../sharing/sharingRuntime.ts'

export interface AndroidBackgroundStatus {
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
  readonly oldSharing?: readonly {
    shareId: string
    name?: string
    endedAt: number
    reason: 'revoked' | 'expired'
  }[]
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
    (candidate.oldSharing !== undefined &&
      (!Array.isArray(candidate.oldSharing) ||
        candidate.oldSharing.some(
          (record) =>
            !record ||
            typeof record.shareId !== 'string' ||
            typeof record.endedAt !== 'number' ||
            !['revoked', 'expired'].includes(record.reason),
        )))
  ) {
    throw new Error('Invalid background sharing status.')
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
      dismissReturnOffer: (shareId: string, fingerprint: string) => Promise<void>
      importSourceState: (state: PrivateState) => Promise<void>
      setViewerName: (
        shareId: string,
        fingerprint: string,
        name: string,
      ) => Promise<AndroidBackgroundStatus>
      blockViewer: (shareId: string, fingerprint: string) => Promise<AndroidBackgroundStatus>
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
    dismissReturnOffer: async (shareId, fingerprint) => {
      await dependencies.invoke('android_dismiss_background_return_offer', {
        shareId,
        fingerprint,
      })
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
  }
}
