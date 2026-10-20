import type { PrivateKey } from '@libp2p/interface'
import type { BrowserLocationState } from '../location/browser.ts'
import type { ApproximationState } from '../location/approximation.ts'
import type { LocationObservationV1 } from '../location/locationObservation.ts'
import type { ShareBatteryPolicy, ShareDraft, ShareNetworkPolicy } from '../shareDraft.ts'
import type { DeviceComparison } from './deviceComparison.ts'
import type { PeerNamePreference } from './peerNames.ts'
import type { PrivateState, StoppedViewerRecord } from './privateStore.ts'
import type { NetworkRestriction, SharePauseState } from './sharePolicy.ts'
import type { ConstellationMessage } from './shareProtocol.ts'
import type { SharingBehavior } from './sharingBehavior.ts'
import type { TransportKind } from './transport.ts'

export type PeerStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface ShareSummary {
  readonly shareId: string
  readonly url: string
  readonly precision: ShareDraft['precision']
  readonly battery: ShareBatteryPolicy
  readonly network: ShareNetworkPolicy
  readonly paused?: SharePauseState
  readonly lastUpdateAt?: number
  readonly expiresAt: number | null
  readonly recipientPeerId?: string
  readonly viewerCount: number
  readonly viewers?: readonly {
    peerId: string
    fingerprint: string
    lastSeenAt: number
    localName?: string
    sourceName?: string
    displayName?: string
  }[]
  readonly name?: string
  readonly publication?: ShareDraft['publication']
}

export type FollowStatus =
  | 'live'
  | 'delayed'
  | 'stale'
  | 'expired'
  | 'revoked'
  | 'unavailable'
  | 'approval-pending'
  | 'denied'

export interface FollowSummary {
  readonly shareId: string
  readonly peerId?: string
  readonly sourceName?: string
  readonly localName: string
  readonly displayName?: string
  readonly color: string
  readonly connected: boolean
  readonly status: FollowStatus
  readonly saved: boolean
  readonly followedAt?: number
  readonly lastLocationAt?: number
  readonly updatesReceived: number
  readonly expiresAt: number | null
  readonly returnPromptSeen: boolean
  readonly approvalPending?: boolean
  readonly approvalDenied?: boolean
  readonly endedAt?: number
}

export interface OldShareSummary {
  readonly cleared?: boolean
  readonly shareId: string
  readonly name?: string
  readonly peerId?: string
  readonly endedAt: number
  readonly reason: 'revoked' | 'expired'
}

export interface SharingRuntimeState {
  readonly sharingBehavior?: SharingBehavior
  readonly paused: boolean
  readonly deviceComparisons?: readonly DeviceComparison[]
  readonly peerStatus: PeerStatus
  readonly location: BrowserLocationState
  readonly peerNamePreferences?: readonly PeerNamePreference[]
  readonly shares: readonly ShareSummary[]
  readonly received: readonly {
    shareId: string
    observation: LocationObservationV1
    state: 'live' | 'delayed' | 'stale'
  }[]
  readonly following: readonly FollowSummary[]
  readonly returnOffers: readonly {
    shareId: string
    viewerFingerprint: string
    ownerPeerId: string
    url: string
  }[]
  readonly approvedReturnLinks: readonly string[]
  readonly pendingViewerApprovals: readonly {
    shareId: string
    peerId: string
    fingerprint: string
    requestedAt: number
  }[]
  readonly oldSharing: readonly OldShareSummary[]
  readonly oldSeeing: readonly OldShareSummary[]
  readonly stoppedViewers: readonly StoppedViewerRecord[]
  readonly endNotifications: readonly {
    shareId: string
    publication: ShareDraft['publication']
    retainUntil: number
  }[]
  readonly message: string
  readonly canSave: boolean
}

export interface NetworkDiagnostics {
  readonly peerStatus: PeerStatus
  readonly sessionEvents: readonly SessionEvent[]
  readonly connections: readonly {
    role: 'viewer' | 'source' | 'other peer'
    transport: TransportKind
    direction: string
    status: string
    connectedAt?: number
    peerId: string
    remoteAddress: string
  }[]
}

export interface SessionEvent {
  readonly sequence: number
  readonly at: number
  readonly event:
    | 'stream-open'
    | 'redeem-denied'
    | 'admitted'
    | 'left'
    | 'transport-closed'
    | 'heartbeat-timeout'
    | 'heartbeat-failed'
    | 'expired'
    | 'blocked'
    | 'stopped'
  readonly activeSessions: number
}

export interface SourceSession {
  readonly peerId: string
  readonly close: () => Promise<void>
  readonly closeAfterFlush: () => Promise<void>
  readonly send: (message: ConstellationMessage) => void
  sessionId?: string
  subscriptionId?: string
  lastHeartbeatAt: number
  fingerprint?: string
}

export interface SourceShare {
  readonly capability: ShareCapability
  readonly url: string
  readonly secret: Uint8Array
  readonly sourcePrivateKey?: PrivateKey
  readonly precision: ShareDraft['precision']
  readonly capacity: number
  readonly requireViewerApproval?: boolean
  claimPending?: boolean
  readonly name?: string
  publication: ShareDraft['publication']
  battery: ShareBatteryPolicy
  network: ShareNetworkPolicy
  readonly sessions: Set<SourceSession>
  readonly viewerPeerIds: Set<string>
  readonly redeemedNonces: Set<string>
  readonly blockedPeerIds: Set<string>
  approvedPeerId?: string
  approximation?: ApproximationState
  latest?: LocationObservationV1
}

export type EndedSourceShare = Pick<
  SourceShare,
  'capability' | 'url' | 'sourcePrivateKey' | 'publication'
> & {
  capacity?: number
  approvedPeerId?: string
  reason: 'revoked' | 'expired'
  endedAt: number
}

export interface FollowEntry {
  readonly url: string
  readonly sourcePeerId: string
  peerId?: string
  sourceName?: string
  linkSourceName?: string
  localName: string
  usesPrivateName?: boolean
  color: string
  connected: boolean
  terminal?: 'expired' | 'revoked' | 'unavailable'
  approvalPending?: boolean
  approvalDenied?: boolean
  saved: boolean
  followedAt?: number
  returnPromptSeen: boolean
  endedAt?: number
  updatesReceived: number
  expiresAt: number | null
}

export interface ReturnOffer {
  shareId: string
  viewerFingerprint: string
  ownerPeerId: string
  url: string
}

export interface PendingViewerApproval {
  shareId: string
  peerId: string
  fingerprint: string
  requestedAt: number
}

export interface PeerHistoryProtection {
  readonly peerIds: readonly string[]
  readonly shareIds: readonly string[]
}

export interface SharingRuntime {
  startDeviceComparison: (shareId: string) => Promise<void>
  confirmDeviceComparison: (shareId: string, challenge: string) => Promise<void>
  cancelDeviceComparison: (shareId: string, challenge: string) => Promise<void>
  networkDiagnostics: () => NetworkDiagnostics
  setNetworkState: (restriction: NetworkRestriction | undefined) => void
  getViewerLabel: (shareId: string, fingerprint: string) => string | undefined
  setPeerNamePreferences: (
    peerId: string,
    associateNames: boolean,
    sharedName: string | null,
  ) => Promise<void>
  adoptPeerName: (peerId: string, name: string) => Promise<void>
  setViewerLabel: (shareId: string, fingerprint: string, name: string) => Promise<void>
  blockViewer: (shareId: string, fingerprint: string) => Promise<void>
  offerReturnShare: (
    followShareId: string,
    url: string,
    options?: { externalBoundRecipientPeerId?: string },
  ) => Promise<void>
  dismissReturnOffer: (shareId: string, fingerprint: string) => Promise<void>
  approveReturnLink: (shareId: string) => Promise<void>
  approveViewer: (shareId: string, peerId: string) => Promise<void>
  signReturnOwnership: (
    shareId: string,
    sourcePeerId: string,
  ) => Promise<{ ownerPeerId: string; ownerProof: string }>
  replaceBackgroundShareOwner: (
    shareId: string,
    sourcePeerId: string,
    ownerPeerId: string,
    ownerProof: string,
    binding:
      | { readonly mode: 'source' }
      | { readonly mode: 'recipient'; readonly recipientPeerId: string },
  ) => Promise<ShareSummary>
  importSourceShares: (incoming: PrivateState) => Promise<void>
  setSharingBehavior: (behavior: SharingBehavior) => Promise<void>
  clearOldPeers: (protection: PeerHistoryProtection) => Promise<void>
  dismissStoppedViewer: (shareId: string, peerId: string) => Promise<void>
  markReturnPromptSeen: (shareId: string) => Promise<void>
  initialize: () => Promise<void>
  subscribe: (observer: (state: SharingRuntimeState) => void) => () => void
  createShare: (
    draft: ShareDraft,
    expiresAt?: number | null,
    linkBaseUrl?: string,
  ) => Promise<ShareSummary>
  acceptShare: (
    url: string,
    options?: { localName?: string; saved?: boolean; returnOwnerPeerId?: string },
  ) => Promise<void>
  saveFollowing: (shareId: string, localName: string) => Promise<void>
  stopFollowing: (shareId: string) => Promise<void>
  setFollowName: (shareId: string, name: string) => void
  setFollowColor: (shareId: string, color: string) => void
  setVisible: (visible: boolean, acquireLocation?: boolean) => void
  setPaused: (paused: boolean) => Promise<void>
  stopShare: (shareId: string) => Promise<void>
  stopEndNotifications: () => Promise<void>
  stop: () => Promise<void>
}

export interface ShareCapability {
  v: 1
  shareId: string
  secret: string
  sourcePeerId: string
  addresses: string[]
  expiresAt: number | null
  ownerPeerId?: string
  ownerProof?: string
}
