import { SharingBehavior } from './sharingBehavior.ts'
import {
  clearPeerHistory,
  hasEndedPeerShare,
  protectActivePeerHistory,
  restoreFailedPeerHistoryClear,
  type PeerHistoryProtection,
} from './peerHistory.ts'
import { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
export { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
import {
  DEVICE_COMPARISON_PROTOCOL,
  COMPARISON_TTL_MS,
  deviceComparisonProtocol,
  createComparisonResponder,
  createComparisonCommit,
  finishComparison,
  reserveComparisonAttempt,
  requireComparisonStreamPeer,
  type DeviceComparison,
  type ComparisonBudget,
} from './deviceComparison.ts'
import { createPortClient, createPortServer } from '@taskyon/protocol'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import type { PrivateKey } from '@libp2p/interface'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

import { projectApproximateLocation, type ApproximationState } from '../location/approximation.ts'
import type { BrowserLocationSource, BrowserLocationState } from '../location/browser.ts'
import {
  acceptNewerLocationObservation,
  type LocationObservationV1,
} from '../location/locationObservation.ts'
import {
  disclosedPrecisionFor,
  shareExpiryFor,
  VERY_COARSE_RADIUS_METERS,
  type ShareBatteryPolicy,
  type ShareDraft,
  type ShareNetworkPolicy,
} from '../shareDraft.ts'
import {
  createProtocolMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
} from './browserPeer.ts'
import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'
import {
  PeerNamePreference,
  displayedPeerName,
  advertisedPeerName,
  receiveAdvertisedName,
  nameAfterContact,
  peerNamesProtocol,
  PEER_NAMES_PROTOCOL,
} from './peerNames.ts'
import { createRedemptionProof, verifyRedemptionProof, verifyStopNoticeProof } from './shareAuth.ts'
import {
  createShareInvitation,
  parseShareInvitation,
  shareInvitationUrl,
  returnOwnerMessage,
  verifyReturnOwner,
  type ShareCapability,
} from './shareLink.ts'
import {
  backgroundSharePolicy,
  sharePauseReason,
  type NetworkRestriction,
  type SharePauseState,
} from './sharePolicy.ts'
import { decryptLocationPayload, encryptLocationPayload } from './sharePayloadCrypto.ts'
import {
  rotatePendingNotice,
  shouldQueueStopNotice,
  dispatchStopDelivery,
  preparePendingStopNotice,
} from './stopNotice.ts'
import {
  constellationProtocolV2,
  SHARE_STREAM_PROTOCOL,
  parseConstellationMessage,
  type ConstellationMessage,
} from './shareProtocol.ts'
import { classifyTransport, type TransportKind } from './transport.ts'
import {
  parsePrivateState,
  type PrivateState,
  type PrivateStateStore,
  type StoppedViewerRecord,
  type PendingStopNotice,
} from './privateStore.ts'
import { END_NOTICE_RETENTION_MS, retainedEndNotifications } from './shareLifecycle.ts'
import { recordStoppedViewer, STOP_NOTICE_RETENTION_MS } from './stopNotice.ts'

const LOCATION_SENSOR_ID = 'location'
const DESCRIPTOR_REVISION = 'constellation-location-v1'
const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_TIMEOUT_MS = 35_000
const MAX_ACTIVE_SESSIONS = 128
const MAX_REMEMBERED_VIEWER_PEERS = MAX_ACTIVE_SESSIONS
const MAX_REDEEMED_NONCES_PER_SHARE = 1_024
const MAX_PENDING_VIEWER_APPROVALS_PER_SHARE = 128

export const sessionSweepReason = (
  expiresAt: number | null,
  lastHeartbeatAt: number,
  now: number,
): 'expired' | 'heartbeat-timeout' | undefined => {
  if (expiresAt !== null && now >= expiresAt) return 'expired'
  if (now - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) return 'heartbeat-timeout'
  return undefined
}

type PeerStatus = 'offline' | 'connecting' | 'online' | 'error'

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

export const followStatusFor = (options: {
  connected: boolean
  observation?: Pick<LocationObservationV1, 'capturedAt' | 'expiresAt'>
  terminal?: 'expired' | 'revoked' | 'unavailable'
  approvalPending?: boolean
  approvalDenied?: boolean
  now?: number
}): FollowStatus => {
  if (options.terminal) return options.terminal
  if (options.approvalDenied) return 'denied'
  if (options.approvalPending) return 'approval-pending'
  if (!options.connected || !options.observation) return 'unavailable'
  const now = options.now ?? Date.now()
  if (now >= options.observation.expiresAt) return 'stale'
  if (now >= options.observation.capturedAt + 15_000) return 'delayed'
  return 'live'
}

export const FOLLOW_COLORS = ['#438ec9', '#8a6fc9', '#289a82', '#c0709a'] as const

export interface SharingRuntimeState {
  readonly sharingBehavior?: SharingBehavior
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

interface SourceSession {
  readonly peerId: string
  readonly close: () => Promise<void>
  readonly closeAfterFlush: () => Promise<void>
  readonly send: (message: ConstellationMessage) => void
  sessionId?: string
  subscriptionId?: string
  lastHeartbeatAt: number
  fingerprint?: string
}

interface SourceShare {
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

type EndedSourceShare = Pick<
  SourceShare,
  'capability' | 'url' | 'sourcePrivateKey' | 'publication'
> & {
  capacity?: number
  approvedPeerId?: string
  reason: 'revoked' | 'expired'
  endedAt: number
}

interface FollowEntry {
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

export const savedFollowRecords = (
  entries: readonly {
    url: string
    localName: string
    sourceName?: string
    usesPrivateName?: boolean
    color: string
    saved: boolean
    followedAt?: number
    returnPromptSeen?: boolean
    approvalDenied?: boolean
    terminal?: 'expired' | 'revoked' | 'unavailable'
    endedAt?: number
  }[],
): PrivateState['followed'] =>
  entries
    .filter((entry) => entry.saved)
    .map(
      ({
        url,
        localName,
        sourceName,
        usesPrivateName,
        color,
        followedAt,
        returnPromptSeen,
        approvalDenied,
        terminal,
        endedAt,
      }) => ({
        url,
        localName,
        ...(sourceName ? { sourceName } : {}),
        ...(usesPrivateName !== undefined ? { usesPrivateName } : {}),
        color,
        ...(followedAt ? { followedAt } : {}),
        ...(returnPromptSeen ? { returnPromptSeen: true } : {}),
        ...(approvalDenied ? { approvalDenied: true } : {}),
        ...(terminal === 'expired' || terminal === 'revoked' ? { endReason: terminal } : {}),
        ...(endedAt ? { endedAt } : {}),
      }),
    )

const viewerFingerprint = async (shareId: string, peerId: string): Promise<string> => {
  const input = new TextEncoder().encode(`${shareId}:${peerId}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return bytesToBase64Url(digest.slice(0, 6))
}

const randomToken = (bytes = 16): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))

const capacityFor = (draft: ShareDraft): number =>
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

const requireAuthorized = (session: SourceSession, share: SourceShare | undefined): SourceShare => {
  if (!share || !session.sessionId) throw new Error('Share access denied.')
  if (share.capability.expiresAt !== null && Date.now() >= share.capability.expiresAt) {
    throw new Error('Share access denied.')
  }
  return share
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
  stopShare: (shareId: string) => Promise<void>
  stopEndNotifications: () => Promise<void>
  stop: () => Promise<void>
}

export const acceptReturnShare = async (
  runtime: Pick<SharingRuntime, 'acceptShare'>,
  offer: SharingRuntimeState['returnOffers'][number],
  isConnected: (shareId: string) => boolean,
): Promise<void> => {
  const capability = parseShareInvitation(offer.url)
  if (!isConnected(capability.shareId)) {
    await runtime.acceptShare(offer.url, { saved: true, returnOwnerPeerId: offer.ownerPeerId })
  }
  if (!isConnected(capability.shareId)) throw new Error('This return location link has ended.')
}

const restoredSourceShare = (
  record: PrivateState['shares'][number],
  behavior: SharingBehavior | undefined,
): SourceShare => {
  const capability = parseShareInvitation(record.url)
  return {
    capability,
    url: record.url,
    secret: base64UrlToBytes(capability.secret),
    ...(record.sourcePrivateKey
      ? {
          sourcePrivateKey: privateKeyFromProtobuf(base64UrlToBytes(record.sourcePrivateKey)),
        }
      : {}),
    precision: record.precision,
    capacity: record.capacity,
    requireViewerApproval: record.requireViewerApproval !== false,
    approvedPeerId: record.approvedPeerId,
    name: record.name,
    publication: behavior?.publication ?? record.publication,
    ...backgroundSharePolicy(
      behavior?.publication ?? record.publication,
      behavior?.battery ?? record.battery ?? 'balanced',
      behavior?.network ?? record.network ?? 'always',
    ),
    sessions: new Set(),
    viewerPeerIds: new Set(record.viewerPeerIds ?? []),
    redeemedNonces: new Set(),
    blockedPeerIds: new Set(record.blockedPeerIds ?? []),
    approximation: record.approximation,
  }
}

const restoredEndedSourceShare = (
  record: NonNullable<PrivateState['endedShares']>[number],
): EndedSourceShare => {
  const capability = parseShareInvitation(record.url, 0)
  return {
    capability,
    capacity: record.capacity,
    approvedPeerId: record.approvedPeerId,
    url: record.url,
    publication: record.publication,
    reason: record.reason,
    endedAt: record.endedAt,
    ...(record.sourcePrivateKey
      ? {
          sourcePrivateKey: privateKeyFromProtobuf(base64UrlToBytes(record.sourcePrivateKey)),
        }
      : {}),
  }
}

export const createSharingRuntime = (
  locationSource: BrowserLocationSource,
  shareBaseUrl = window.location.origin + window.location.pathname,
  store?: PrivateStateStore,
  returnShareReceiver: 'local' | 'external' = 'local',
): SharingRuntime => {
  const deviceComparisons = new Map<string, DeviceComparison>()
  const comparisonBudgets: ComparisonBudget[] = []
  const comparisonRuns = new Map<string, { cancelled: boolean; close?: () => Promise<void> }>()
  const observers = new Set<(state: SharingRuntimeState) => void>()
  const shares = new Map<string, SourceShare>()
  const endedShares = new Map<string, EndedSourceShare>()
  const pendingRevocations = new Set<string>()
  const received = new Map<string, LocationObservationV1>()
  const followed = new Map<string, FollowEntry>()
  const viewerLabels = new Map<string, string>()
  const peerNamePreferences = new Map<string, PeerNamePreference>()
  const nameListeners = new Map<string, Set<(name: string | null) => void>>()
  const nameSenders = new Map<
    string,
    { send: (name: string | null) => Promise<void>; close: () => Promise<void> }
  >()
  const namePreference = (peerId: string): PeerNamePreference =>
    peerNamePreferences.get(peerId) ?? {
      peerId,
      associateNames: false,
      sharedName: null,
      receivedName: null,
    }
  const receivePeerName = async (peerId: string, receivedName: string | null): Promise<void> => {
    if (peerNamePreferences.size >= 1_024 && !peerNamePreferences.has(peerId)) return
    const previous = namePreference(peerId)
    const currentFollow = [...followed.values()].find((entry) => entry.peerId === peerId)
    const currentName =
      currentFollow?.sourceName ||
      (currentFollow?.usesPrivateName ? currentFollow.localName : undefined)
    const next = receiveAdvertisedName(previous, receivedName, currentName)
    const previousEntries = [...followed.values()]
      .filter((entry) => entry.peerId === peerId)
      .map((entry) => ({ entry, localName: entry.localName, sourceName: entry.sourceName }))
    peerNamePreferences.set(peerId, next)
    for (const { entry } of previousEntries) {
      if (!entry.usesPrivateName && !entry.sourceName && !previous.acceptedName && receivedName)
        entry.localName = receivedName
      entry.sourceName = receivedName ?? entry.linkSourceName
    }
    try {
      await persist()
    } catch {
      peerNamePreferences.set(peerId, previous)
      for (const { entry, localName, sourceName } of previousEntries) {
        entry.localName = localName
        entry.sourceName = sourceName
      }
      publish({ message: 'Received name could not be saved.' })
      return
    }
    publish()
  }

  const viewerClosers = new Map<
    string,
    (explicit?: boolean, eventId?: string) => Promise<boolean>
  >()
  const returnSenders = new Map<string, (url: string) => Promise<void>>()
  const returnOffers = new Map<
    string,
    { shareId: string; viewerFingerprint: string; ownerPeerId: string; url: string }
  >()
  const approvedReturnLinks = new Set<string>()
  const pendingViewerApprovals = new Map<
    string,
    { shareId: string; peerId: string; fingerprint: string; requestedAt: number }
  >()
  const viewerApprovalKey = (shareId: string, peerId: string): string =>
    JSON.stringify([shareId, peerId])
  const pendingReturns = new Map<string, string>()
  const oldSharing = new Map<string, OldShareSummary>()
  const oldSeeing = new Map<string, OldShareSummary>()
  const stoppedViewers = new Map<string, StoppedViewerRecord>()
  const pendingStopNotices = new Map<string, PendingStopNotice>()
  let retryingStopNotices = false
  const insertImportedEntries = <T>(
    target: Map<string, T>,
    entries: Iterable<readonly [string, T]>,
  ): (() => void) => {
    const added: [string, T][] = []
    for (const [key, value] of entries) {
      if (target.has(key)) continue
      target.set(key, value)
      added.push([key, value])
    }
    return () => {
      for (const [key, value] of added) if (target.get(key) === value) target.delete(key)
    }
  }
  const applyHistoryRecords = <T>(
    target: Map<string, T>,
    records: ReadonlyMap<string, T>,
  ): void => {
    target.clear()
    for (const [key, record] of records) target.set(key, record)
  }
  let stopRetryAt = 0
  let runtimeClosed = false
  const stoppedViewerKey = (shareId: string, peerId: string): string =>
    JSON.stringify([shareId, peerId])
  const rememberLifecycleRecord = (
    history: Map<string, OldShareSummary>,
    record: OldShareSummary,
  ): void => {
    const key = JSON.stringify([record.shareId, record.peerId ?? null])
    history.set(key, record)
    while (history.size > 128) {
      const oldest = [...history.entries()].reduce((left, right) =>
        left[1].endedAt <= right[1].endedAt ? left : right,
      )
      history.delete(oldest[0])
    }
  }
  const rememberEndedShareHistory = (
    share: { shareId: string; name?: string; viewerPeerIds: Iterable<string> },
    reason: OldShareSummary['reason'],
    endedAt: number,
  ): void => {
    const peerIds = [...share.viewerPeerIds].slice(0, MAX_REMEMBERED_VIEWER_PEERS)
    for (const peerId of peerIds.length ? peerIds : [undefined]) {
      rememberLifecycleRecord(oldSharing, {
        shareId: share.shareId,
        ...(peerId ? { peerId } : {}),
        ...(share.name ? { name: share.name } : {}),
        reason,
        endedAt,
      })
    }
  }
  const rememberViewerPeer = (share: SourceShare, peerId: string): boolean => {
    if (share.viewerPeerIds.has(peerId)) return false
    share.viewerPeerIds.add(peerId)
    if (share.viewerPeerIds.size > MAX_REMEMBERED_VIEWER_PEERS) {
      const inactivePeer = [...share.viewerPeerIds].find(
        (rememberedPeerId) =>
          ![...share.sessions].some((activeSession) => activeSession.peerId === rememberedPeerId),
      )
      share.viewerPeerIds.delete(inactivePeer ?? peerId)
    }
    return share.viewerPeerIds.has(peerId)
  }
  let noticeTimer: number | undefined
  const reconnecting = new Set<string>()
  const sourceNodes = new Map<string, BrowserLibp2pNode>()
  const sourceStarts = new Map<string, Promise<{ node: BrowserLibp2pNode; addresses: string[] }>>()
  let peer: Promise<{ node: BrowserLibp2pNode; addresses: string[] }> | undefined
  let handlerNode: BrowserLibp2pNode | undefined
  let visible = true
  let privateKey: PrivateKey | undefined
  let preparation: Promise<void> | undefined
  let persistence = Promise.resolve()
  let privateStateAvailable = true
  let sessionEvents: readonly SessionEvent[] = []
  let sessionEventSequence = 0
  let sharingBehavior: SharingBehavior | undefined
  let pendingSharingBehavior: SharingBehavior | undefined
  let networkRestriction: NetworkRestriction | undefined
  let state: SharingRuntimeState = {
    peerStatus: 'offline',
    location: locationSource.getState(),
    shares: [],
    received: [],
    following: [],
    returnOffers: [],
    approvedReturnLinks: [],
    pendingViewerApprovals: [],
    oldSharing: [],
    oldSeeing: [],
    stoppedViewers: [],
    endNotifications: [],
    message: '',
    canSave: Boolean(store),
  }

  const publish = (patch: Partial<SharingRuntimeState> = {}): void => {
    if (Object.hasOwn(patch, 'message')) {
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
      noticeTimer = undefined
      if (patch.message) {
        noticeTimer = window.setTimeout(() => {
          noticeTimer = undefined
          publish({ message: '' })
        }, 6_000)
      }
    }
    const now = Date.now()
    state = {
      ...state,
      ...patch,
      sharingBehavior,
      peerNamePreferences: [...peerNamePreferences.values()],
      shares: [...shares.values()].map((share) => ({
        shareId: share.capability.shareId,
        url: share.url,
        precision: share.precision,
        expiresAt: share.capability.expiresAt,
        recipientPeerId: share.approvedPeerId,
        viewerCount: share.sessions.size,
        viewers: [...share.sessions]
          .filter((session) => session.fingerprint)
          .map((session) => {
            const preference = peerNamePreferences.get(session.peerId)
            const localName =
              (preference?.associateNames ? preference.nickname : undefined) ||
              viewerLabels.get(`${share.capability.shareId}:${session.fingerprint}`)
            return {
              peerId: session.peerId,
              fingerprint: session.fingerprint!,
              displayName: displayedPeerName(preference, localName, 'Connected peer'),
              lastSeenAt: session.lastHeartbeatAt,
              ...(localName ? { localName } : {}),
              ...(preference?.receivedName ? { sourceName: preference.receivedName } : {}),
            }
          }),
        ...(share.name ? { name: share.name } : {}),
        publication: share.publication,
        battery: share.battery,
        network: share.network,
        ...(sharePauseReason(share, networkRestriction)
          ? { paused: sharePauseReason(share, networkRestriction) }
          : {}),
        ...(share.latest ? { lastUpdateAt: share.latest.capturedAt } : {}),
      })),
      received: [...received.entries()].map(([shareId, observation]) => ({
        shareId,
        observation,
        state:
          !followed.get(shareId)?.connected || now >= observation.expiresAt
            ? 'stale'
            : now >= observation.capturedAt + 15_000
              ? 'delayed'
              : 'live',
      })),
      following: [...followed.entries()].map(([shareId, entry]) => {
        const observation = received.get(shareId)
        const displayName = displayedPeerName(
          entry.peerId ? peerNamePreferences.get(entry.peerId) : undefined,
          entry.usesPrivateName ? entry.localName : undefined,
          entry.localName,
        )
        return {
          shareId,
          peerId: entry.peerId,
          sourceName: entry.sourceName,
          displayName,
          localName: displayName,
          color: entry.color,
          connected: entry.connected,
          status: followStatusFor({
            connected: entry.connected,
            observation,
            approvalPending: entry.approvalPending,
            approvalDenied: entry.approvalDenied,
            terminal:
              entry.terminal ??
              (entry.expiresAt !== null && now >= entry.expiresAt ? 'expired' : undefined),
            now,
          }),
          saved: entry.saved,
          ...(entry.followedAt ? { followedAt: entry.followedAt } : {}),
          ...(observation ? { lastLocationAt: observation.capturedAt } : {}),
          updatesReceived: entry.updatesReceived,
          expiresAt: entry.expiresAt,
          returnPromptSeen: entry.returnPromptSeen,
          ...(entry.approvalPending ? { approvalPending: true } : {}),
          ...(entry.approvalDenied ? { approvalDenied: true } : {}),
          ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
        }
      }),
      endNotifications: [...endedShares.values()].map((share) => ({
        shareId: share.capability.shareId,
        publication: share.publication,
        retainUntil: share.endedAt + END_NOTICE_RETENTION_MS,
      })),
      returnOffers: [...returnOffers.values()],
      approvedReturnLinks: [...approvedReturnLinks],
      pendingViewerApprovals: [...pendingViewerApprovals.values()],
      deviceComparisons: [...deviceComparisons.values()].filter(comparisonIsCurrent),
      oldSharing: [...oldSharing.values()]
        .filter((record) => !record.cleared)
        .sort((left, right) => right.endedAt - left.endedAt),
      oldSeeing: [...oldSeeing.values()]
        .filter((record) => !record.cleared)
        .sort((left, right) => right.endedAt - left.endedAt),
      stoppedViewers: [...stoppedViewers.values()]
        .filter((record) => !record.cleared)
        .sort((left, right) => right.recordedAt - left.recordedAt),
    }
    observers.forEach((observer) => observer(state))
  }

  const snapshot = (): PrivateState => {
    if (!privateKey) throw new Error('Protected peer identity is unavailable.')
    const behavior = pendingSharingBehavior ?? sharingBehavior
    return {
      ...(behavior ? { sharingBehavior: behavior } : {}),
      version: 1,
      deviceComparisons: [...deviceComparisons.values()].filter(
        (entry) => entry.confirmedAt !== undefined && comparisonIsCurrent(entry),
      ),
      comparisonBudgets,
      privateKey: bytesToBase64Url(privateKeyToProtobuf(privateKey)),
      shares: [...shares.values()].map((share) => {
        const policy = pendingSharingBehavior
          ? {
              publication: pendingSharingBehavior.publication,
              ...backgroundSharePolicy(
                pendingSharingBehavior.publication,
                pendingSharingBehavior.battery,
                pendingSharingBehavior.network,
              ),
            }
          : { publication: share.publication, battery: share.battery, network: share.network }
        return {
          url: share.url,
          ...(share.sourcePrivateKey
            ? {
                sourcePrivateKey: bytesToBase64Url(privateKeyToProtobuf(share.sourcePrivateKey)),
              }
            : {}),
          precision: share.precision,
          capacity: share.capacity,
          ...(share.requireViewerApproval === false ? { requireViewerApproval: false } : {}),
          ...(share.approvedPeerId ? { approvedPeerId: share.approvedPeerId } : {}),
          ...(share.viewerPeerIds.size ? { viewerPeerIds: [...share.viewerPeerIds] } : {}),
          name: share.name,
          ...policy,
          blockedPeerIds: [...share.blockedPeerIds],
          approximation: share.approximation,
        }
      }),
      endedShares: [...endedShares.values()].map((share) => ({
        url: share.url,
        ...(share.sourcePrivateKey
          ? {
              sourcePrivateKey: bytesToBase64Url(privateKeyToProtobuf(share.sourcePrivateKey)),
            }
          : {}),
        ...(share.capacity ? { capacity: share.capacity } : {}),
        ...(share.approvedPeerId ? { approvedPeerId: share.approvedPeerId } : {}),
        publication: share.publication,
        reason: share.reason,
        endedAt: share.endedAt,
      })),
      peerNamePreferences: [...peerNamePreferences.values()],
      followed: savedFollowRecords([...followed.values()]),
      approvedReturnLinks: [...approvedReturnLinks],
      pendingReturns: [...pendingReturns].map(([shareId, url]) => ({ shareId, url })),
      returnOffers: [...returnOffers.values()],
      oldSharing: [...oldSharing.values()],
      stoppedViewers: [...stoppedViewers.values()],
      pendingStopNotices: [...pendingStopNotices.values()],
      oldSeeing: [...oldSeeing.values()],
      viewerLabels: [...viewerLabels].map(([key, name]) => {
        const separator = key.indexOf(':')
        return { shareId: key.slice(0, separator), fingerprint: key.slice(separator + 1), name }
      }),
    }
  }

  const persist = (traceFollow = false): Promise<void> => {
    if (!store) return Promise.resolve()
    if (!privateStateAvailable) {
      return Promise.reject(
        new Error('Protected storage is unavailable; this location can only be previewed.'),
      )
    }
    const saved = snapshot()
    persistence = persistence
      .catch(() => undefined)
      .then(async () => {
        if (traceFollow) console.info('[constellation-persist] native-save-start')
        await store.save(saved)
        if (traceFollow) console.info('[constellation-persist] native-save-complete')
      })
    return persistence
  }

  const useEphemeralIdentity = async (): Promise<void> => {
    privateStateAvailable = false
    privateKey ??= await generateKeyPair('Ed25519')
    publish({ canSave: false, message: 'Protected storage is unavailable; preview only.' })
  }

  const prepareState = (): Promise<void> => {
    if (!store) return Promise.resolve()
    if (!preparation) {
      preparation = (async () => {
        let saved: PrivateState | undefined
        try {
          saved = await store.load()
        } catch {
          await useEphemeralIdentity()
          return
        }
        privateKey = saved
          ? privateKeyFromProtobuf(base64UrlToBytes(saved.privateKey))
          : await generateKeyPair('Ed25519')
        if (!saved) {
          try {
            await persist()
          } catch {
            await useEphemeralIdentity()
            return
          }
        }
        sharingBehavior = saved?.sharingBehavior
        comparisonBudgets.push(...(saved?.comparisonBudgets ?? []))
        for (const entry of saved?.deviceComparisons ?? [])
          deviceComparisons.set(entry.challenge, entry)
        let changedProtectedState = false
        for (const record of saved?.shares ?? []) {
          try {
            const capability = parseShareInvitation(record.url)
            const restored = restoredSourceShare(record, sharingBehavior)
            shares.set(capability.shareId, restored)
          } catch {
            changedProtectedState = true
            try {
              const expired = parseShareInvitation(record.url, 0)
              if (expired.expiresAt !== null && expired.expiresAt <= Date.now()) {
                endedShares.set(expired.shareId, {
                  capacity: record.capacity,
                  approvedPeerId: record.approvedPeerId,
                  capability: expired,
                  url: record.url,
                  publication: record.publication,
                  reason: 'expired',
                  endedAt: expired.expiresAt,
                  ...(record.sourcePrivateKey
                    ? {
                        sourcePrivateKey: privateKeyFromProtobuf(
                          base64UrlToBytes(record.sourcePrivateKey),
                        ),
                      }
                    : {}),
                })
                rememberEndedShareHistory(
                  {
                    shareId: expired.shareId,
                    name: record.name,
                    viewerPeerIds: record.viewerPeerIds ?? [],
                  },
                  'expired',
                  expired.expiresAt,
                )
              }
            } catch {
              // Invalid links remain discarded without retaining their contents.
            }
          }
        }
        const retained = retainedEndNotifications(saved?.endedShares ?? [])
        changedProtectedState ||= retained.length !== (saved?.endedShares?.length ?? 0)
        for (const record of retained) {
          try {
            const capability = parseShareInvitation(record.url, 0)
            if (shares.has(capability.shareId)) {
              changedProtectedState = true
              continue
            }
            endedShares.set(capability.shareId, restoredEndedSourceShare(record))
          } catch {
            changedProtectedState = true
          }
        }
        for (const preference of saved?.peerNamePreferences ?? [])
          peerNamePreferences.set(preference.peerId, preference)
        for (const record of saved?.followed ?? []) {
          try {
            const capability = parseShareInvitation(record.url)
            const knownPeerId =
              capability.ownerPeerId && (await verifyReturnOwner(capability))
                ? capability.ownerPeerId
                : undefined
            followed.set(capability.shareId, {
              url: record.url,
              sourcePeerId: capability.sourcePeerId,
              peerId: knownPeerId,
              localName: record.localName,
              sourceName: record.sourceName,
              usesPrivateName:
                record.usesPrivateName ??
                record.localName !== generatedFollowName(capability.shareId),
              color: record.color,
              connected: false,
              saved: true,
              followedAt: record.followedAt,
              returnPromptSeen: record.returnPromptSeen ?? false,
              approvalDenied: record.approvalDenied ?? false,
              ...(record.endReason ? { terminal: record.endReason } : {}),
              ...(record.endedAt ? { endedAt: record.endedAt } : {}),
              updatesReceived: 0,
              expiresAt: capability.expiresAt,
            })
          } catch {
            try {
              const expired = parseShareInvitation(record.url, 0)
              if (expired.expiresAt !== null && expired.expiresAt <= Date.now()) {
                const endedAt = expired.expiresAt
                followed.set(expired.shareId, {
                  url: record.url,
                  sourcePeerId: expired.sourcePeerId,
                  localName: record.localName,
                  color: record.color,
                  connected: false,
                  saved: true,
                  returnPromptSeen: record.returnPromptSeen ?? true,
                  terminal: 'expired',
                  endedAt,
                  updatesReceived: 0,
                  expiresAt: expired.expiresAt,
                })
                rememberLifecycleRecord(oldSeeing, {
                  ...(expired.ownerPeerId ? { peerId: expired.ownerPeerId } : {}),
                  shareId: expired.shareId,
                  name: record.localName,
                  reason: 'expired',
                  endedAt,
                })
                changedProtectedState = true
              }
            } catch {
              // Invalid links are not restored.
            }
          }
        }
        for (const record of saved?.viewerLabels ?? []) {
          viewerLabels.set(`${record.shareId}:${record.fingerprint}`, record.name)
        }
        for (const shareId of saved?.approvedReturnLinks ?? []) approvedReturnLinks.add(shareId)
        for (const { shareId, url } of saved?.pendingReturns ?? []) pendingReturns.set(shareId, url)
        for (const offer of saved?.returnOffers ?? []) {
          returnOffers.set(`${offer.shareId}:${offer.viewerFingerprint}`, offer)
        }
        for (const record of saved?.oldSharing ?? []) rememberLifecycleRecord(oldSharing, record)
        for (const record of saved?.oldSeeing ?? []) rememberLifecycleRecord(oldSeeing, record)
        for (const record of saved?.stoppedViewers ?? []) {
          stoppedViewers.set(stoppedViewerKey(record.shareId, record.peerId), record)
        }
        for (const pending of saved?.pendingStopNotices ?? []) {
          if (Date.now() - pending.queuedAt < STOP_NOTICE_RETENTION_MS) {
            pendingStopNotices.set(pending.eventId, pending)
          } else {
            changedProtectedState = true
          }
        }
        for (const shareId of approvedReturnLinks) {
          if (shares.has(shareId)) continue
          approvedReturnLinks.delete(shareId)
          changedProtectedState = true
        }
        for (const [key, offer] of returnOffers) {
          if (shares.has(offer.shareId)) continue
          returnOffers.delete(key)
          changedProtectedState = true
        }
        const prunedEndIds = pruneEndNotifications()
        changedProtectedState ||= prunedEndIds.length > 0
        if (saved && changedProtectedState) await persist()
        const currentLocation = locationSource.getState()
        if (
          (currentLocation.status === 'live' || currentLocation.status === 'delayed') &&
          currentLocation.observation.expiresAt > Date.now()
        ) {
          let changed = false
          for (const share of shares.values()) {
            if (updateShareLocation(share, currentLocation.observation)) changed = true
          }
          if (changed) {
            void persist().catch(() =>
              publish({ message: 'Private share state could not be saved.' }),
            )
          }
        }
        publish()
      })().catch((error) => {
        preparation = undefined
        publish({
          peerStatus: 'error',
          message: error instanceof Error ? error.message : 'Protected shares could not be opened.',
        })
        throw error
      })
    }
    return preparation
  }

  const recordSessionEvent = (event: SessionEvent['event']): void => {
    sessionEvents = appendSessionEvent(sessionEvents, {
      sequence: ++sessionEventSequence,
      at: Date.now(),
      event,
      activeSessions: [...shares.values()].reduce((count, share) => count + share.sessions.size, 0),
    })
  }

  const removeSession = (session: SourceSession, reason: SessionEvent['event']): void => {
    let removed = false
    for (const share of shares.values()) {
      if (share.sessions.delete(session)) removed = true
    }
    if (removed) recordSessionEvent(reason)
    publish()
  }

  const encryptedObservationMessage = async (
    share: SourceShare,
    subscriptionId: string,
  ): Promise<ConstellationMessage | undefined> => {
    if (sharePauseReason(share, networkRestriction)) return undefined
    if (!share.latest) return undefined
    const observation = share.latest
    const payload = await encryptLocationPayload(
      share.secret,
      share.capability.shareId,
      observation,
    )
    return constellationProtocolV2.streams['sensor.observations'].observation.parse({
      type: 'observation',
      subscriptionId,
      observation: {
        sensorId: LOCATION_SENSOR_ID,
        descriptorRevision: DESCRIPTOR_REVISION,
        sourcePrincipal: share.capability.sourcePeerId,
        sequence: observation.sequence,
        capturedAt: observation.capturedAt,
        expiresAt: observation.expiresAt,
        payload,
      },
    })
  }

  const comparisonPeerIsEligible = (
    entry: Pick<DeviceComparison, 'shareId' | 'peerId' | 'ownPeerId' | 'role'>,
  ): boolean => {
    const share = shares.get(entry.shareId)
    if (entry.role === 'sender') {
      return Boolean(
        share &&
          share.capability.sourcePeerId === entry.ownPeerId &&
          !share.blockedPeerIds.has(entry.peerId) &&
          !pendingRevocations.has(entry.shareId) &&
          (share.capability.expiresAt === null || Date.now() < share.capability.expiresAt) &&
          (share.approvedPeerId
            ? share.approvedPeerId === entry.peerId
            : pendingViewerApprovals.has(viewerApprovalKey(entry.shareId, entry.peerId))),
      )
    }
    const follow = followed.get(entry.shareId)
    return Boolean(
      follow &&
        follow.sourcePeerId === entry.peerId &&
        (!handlerNode || handlerNode.peerId.toString() === entry.ownPeerId) &&
        !follow.terminal &&
        (follow.expiresAt === null || Date.now() < follow.expiresAt) &&
        !follow.approvalDenied,
    )
  }

  const comparisonIsCurrent = (entry: DeviceComparison): boolean =>
    (entry.confirmedAt !== undefined || Date.now() < entry.expiresAt) &&
    comparisonPeerIsEligible(entry)

  const reserveDeviceComparison = (shareId: string, ownPeerId: string): Promise<void> =>
    reserveComparisonAttempt(comparisonBudgets, shareId, ownPeerId, async () => {
      for (const [key, entry] of deviceComparisons)
        if (entry.shareId === shareId) deviceComparisons.delete(key)
      publish()
      await persist()
    })

  const handleComparisonStream = (
    stream: Parameters<typeof createProtocolMessagePort>[0],
    connection: { remotePeer: { toString: () => string } },
    expectedShareId?: string,
  ): void => {
    const port = createProtocolMessagePort(stream, (value) =>
      deviceComparisonProtocol.message.parse(value),
    )
    const responder = createComparisonResponder({
      now: Date.now,
      authorize: (shareId) => {
        const share = shares.get(shareId)
        const peerId = connection.remotePeer.toString()
        if (
          !store ||
          !privateStateAvailable ||
          !share ||
          share.capacity !== 1 ||
          (expectedShareId === undefined
            ? share.sourcePrivateKey !== undefined
            : expectedShareId !== shareId) ||
          !comparisonPeerIsEligible({
            shareId,
            peerId,
            ownPeerId: share.capability.sourcePeerId,
            role: 'sender',
          })
        )
          throw new Error('Device comparison denied.')
        return Promise.resolve({
          secret: share.secret,
          binding: { shareId, sourcePeerId: share.capability.sourcePeerId, viewerPeerId: peerId },
        })
      },
      reserve: (binding) => reserveDeviceComparison(binding.shareId, binding.sourcePeerId),
      complete: ({ binding, ...result }) => {
        // A new exchange replaces the previous local confirmation for this binding.
        for (const [key, entry] of deviceComparisons)
          if (entry.shareId === binding.shareId) deviceComparisons.delete(key)
        deviceComparisons.set(result.challenge, {
          ...result,
          shareId: binding.shareId,
          ownPeerId: binding.sourcePeerId,
          peerId: binding.viewerPeerId,
          role: 'sender',
        })
        publish()
      },
    })
    const stopServer = createPortServer(
      port.port,
      deviceComparisonProtocol,
      { comparison: { commit: responder.commit, reveal: responder.reveal } },
      { onError: () => undefined },
    )
    const timeout = window.setTimeout(() => {
      responder.cancel()
      void port.close()
    }, COMPARISON_TTL_MS)
    void port.closed.then(() => {
      window.clearTimeout(timeout)
      responder.cancel()
      stopServer()
    })
  }

  const handleIncomingStream = (
    stream: Parameters<typeof createProtocolMessagePort>[0],
    connection: { remotePeer: { toString: () => string } },
    expectedShareId?: string,
  ): void => {
    recordSessionEvent('stream-open')
    const messagePort = createProtocolMessagePort(stream, parseConstellationMessage)
    const session: SourceSession = {
      peerId: connection.remotePeer.toString(),
      close: () => messagePort.close(),
      closeAfterFlush: () => messagePort.closeAfterFlush(),
      send: messagePort.port.send,
      lastHeartbeatAt: Date.now(),
    }
    let authorizedShare: SourceShare | undefined
    const stopServer = createPortServer(
      messagePort.port,
      constellationProtocolV2,
      {
        share: {
          redeem: async ({ shareId, viewerNonce, proof }) => {
            const ended = endedShares.get(shareId)
            if (
              ended &&
              !pendingRevocations.has(shareId) &&
              ended.endedAt + END_NOTICE_RETENTION_MS > Date.now() &&
              (expectedShareId === undefined
                ? !ended.sourcePrivateKey
                : expectedShareId === shareId) &&
              (await verifyRedemptionProof(
                base64UrlToBytes(ended.capability.secret),
                {
                  shareId,
                  sourcePeerId: ended.capability.sourcePeerId,
                  viewerPeerId: session.peerId,
                  viewerNonce,
                },
                proof,
              ))
            ) {
              return { ended: true as const, reason: ended.reason, endedAt: ended.endedAt }
            }
            const candidate = shares.get(shareId)
            const servedByThisPeer =
              candidate &&
              (expectedShareId === undefined
                ? candidate.sourcePrivateKey === undefined
                : candidate.capability.shareId === expectedShareId)
            const proofValid =
              servedByThisPeer &&
              !candidate.redeemedNonces.has(viewerNonce) &&
              (candidate.capability.expiresAt === null ||
                Date.now() < candidate.capability.expiresAt) &&
              (await verifyRedemptionProof(
                candidate.secret,
                {
                  shareId,
                  sourcePeerId: candidate.capability.sourcePeerId,
                  viewerPeerId: session.peerId,
                  viewerNonce,
                },
                proof,
              ))
            if (!candidate || !proofValid) {
              recordSessionEvent('redeem-denied')
              throw new Error('Share access denied.')
            }
            session.fingerprint = await viewerFingerprint(shareId, session.peerId)
            if (candidate.blockedPeerIds.has(session.peerId)) {
              return { accessDenied: true as const }
            }
            if (candidate.capacity === 1) {
              if (candidate.approvedPeerId && candidate.approvedPeerId !== session.peerId)
                return { accessDenied: true as const }
              if (candidate.claimPending)
                return { approvalPending: true as const, retryAfterMs: HEARTBEAT_INTERVAL_MS }
              if (candidate.approvedPeerId !== session.peerId) {
                if (candidate.requireViewerApproval !== false) {
                  const key = viewerApprovalKey(shareId, session.peerId)
                  if (!pendingViewerApprovals.has(key)) {
                    const pendingCount = [...pendingViewerApprovals.values()].filter(
                      (request) => request.shareId === shareId,
                    ).length
                    if (pendingCount >= MAX_PENDING_VIEWER_APPROVALS_PER_SHARE)
                      return { accessDenied: true as const }
                    pendingViewerApprovals.set(key, {
                      shareId,
                      peerId: session.peerId,
                      fingerprint: session.fingerprint,
                      requestedAt: Date.now(),
                    })
                    publish()
                  }
                  return { approvalPending: true as const, retryAfterMs: HEARTBEAT_INTERVAL_MS }
                }
                // The first authenticated device claims the link before location access.
                const claim = await claimSingleRecipient(candidate, session.peerId, persist)
                if (claim === 'denied') return { accessDenied: true as const }
                if (claim === 'pending')
                  return { approvalPending: true as const, retryAfterMs: HEARTBEAT_INTERVAL_MS }
              }
            }
            if (candidate.sessions.size >= candidate.capacity) {
              recordSessionEvent('redeem-denied')
              throw new Error('Share access denied.')
            }
            authorizedShare = candidate
            session.sessionId = randomToken()
            session.lastHeartbeatAt = Date.now()
            pendingViewerApprovals.delete(viewerApprovalKey(shareId, session.peerId))
            rememberRedeemedNonce(candidate.redeemedNonces, viewerNonce)
            candidate.sessions.add(session)
            if (rememberViewerPeer(candidate, session.peerId)) {
              try {
                await persist()
              } catch {
                publish({ message: 'Authenticated viewer history could not be saved.' })
              }
            }
            recordSessionEvent('admitted')
            publish()
            return {
              sessionId: session.sessionId,
              expiresAt: candidate.capability.expiresAt,
              precision: disclosedPrecisionFor(candidate.precision),
              ...(candidate.name ? { sourceName: candidate.name } : {}),
              heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            }
          },
          heartbeat: ({ sessionId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId || !share.sessions.has(session)) {
              throw new Error('Share access denied.')
            }
            session.lastHeartbeatAt = Date.now()
            return { receivedAt: session.lastHeartbeatAt }
          },
          leave: ({ sessionId }) => {
            requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId) throw new Error('Share access denied.')
            removeSession(session, 'left')
          },
          stopFollowing: async ({ sessionId, eventId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId || !share.sessions.has(session)) {
              throw new Error('Share access denied.')
            }
            const recordedAt = await recordStoppedViewer(
              stoppedViewers,
              {
                shareId: share.capability.shareId,
                peerId: session.peerId,
                eventId,
              },
              persist,
            )
            removeSession(session, 'left')
            publish({ message: 'A viewer stopped following.' })
            return { recordedAt }
          },
          // A one-shot authenticated stop notice does not redeem or subscribe.
          // This lets a viewer report a deliberate stop after losing connectivity.
          stopNotice: async ({ shareId, eventId, proof }) => {
            const active = shares.get(shareId)
            const ended = endedShares.get(shareId)
            const capability = active?.capability ?? ended?.capability
            const servedHere =
              expectedShareId === undefined
                ? Boolean(capability && !(active?.sourcePrivateKey ?? ended?.sourcePrivateKey))
                : shareId === expectedShareId
            if (
              !capability ||
              !servedHere ||
              pendingRevocations.has(shareId) ||
              (ended && Date.now() >= ended.endedAt + END_NOTICE_RETENTION_MS) ||
              (active?.capacity === 1 && active.approvedPeerId !== session.peerId) ||
              (ended?.capacity === 1 && ended.approvedPeerId !== session.peerId) ||
              active?.blockedPeerIds.has(session.peerId) ||
              !(await verifyStopNoticeProof(
                base64UrlToBytes(capability.secret),
                {
                  shareId,
                  sourcePeerId: capability.sourcePeerId,
                  viewerPeerId: session.peerId,
                  eventId,
                },
                proof,
              ))
            ) {
              throw new Error('Stop notice access denied.')
            }
            const recordedAt = await recordStoppedViewer(
              stoppedViewers,
              {
                shareId,
                peerId: session.peerId,
                eventId,
              },
              persist,
            )
            publish({ message: 'A viewer stopped following.' })
            return { recordedAt }
          },
          offerReturn: async ({ sessionId, url, ownerPeerId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId || !share.sessions.has(session)) {
              throw new Error('Share access denied.')
            }
            const offered = parseShareInvitation(url)
            if (
              !session.fingerprint ||
              offered.shareId === share.capability.shareId ||
              ownerPeerId !== session.peerId ||
              !(await verifyReturnOwner(offered, session.peerId))
            ) {
              throw new Error('Invalid return share.')
            }
            const key = `${share.capability.shareId}:${session.fingerprint}`
            const offer = {
              shareId: share.capability.shareId,
              viewerFingerprint: session.fingerprint,
              ownerPeerId: session.peerId,
              url,
            }
            returnOffers.set(key, offer)
            await persist()
            if (approvedReturnLinks.has(share.capability.shareId)) {
              try {
                if (await acceptPendingReturn(key, offer)) {
                  publish({ message: 'A viewer shared back and was accepted automatically.' })
                  return
                }
              } catch {
                // Preserve the queued offer for an explicit retry.
              }
            }
            publish()
          },
        },
        sensor: {
          describe: ({ sensorId }) => {
            requireAuthorized(session, authorizedShare)
            if (sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
            return {
              sensorId,
              profile: { id: 'dev.constellation.location', version: '1' },
              descriptorRevision: DESCRIPTOR_REVISION,
            }
          },
          subscribe: async ({ sensorId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
            session.subscriptionId = randomToken()
            const initial = await encryptedObservationMessage(share, session.subscriptionId)
            if (initial) session.send(initial)
            if (
              (visible || share.publication === 'background') &&
              !sharePauseReason(share, networkRestriction)
            ) {
              locationSource.refresh()
            }
            return { subscriptionId: session.subscriptionId }
          },
          unsubscribe: ({ subscriptionId }) => {
            requireAuthorized(session, authorizedShare)
            if (session.subscriptionId !== subscriptionId) {
              throw new Error('Sensor access denied.')
            }
            session.subscriptionId = undefined
          },
        },
      },
      { onError: () => undefined },
    )
    void messagePort.closed.then(() => {
      stopServer()
      removeSession(session, 'transport-closed')
    })
  }

  const handleNameStream = (
    stream: Parameters<typeof createProtocolMessagePort>[0],
    connection: { remotePeer: { toString: () => string } },
    expectedShareId?: string,
  ): void => {
    const port = createProtocolMessagePort(stream, (value) =>
      peerNamesProtocol.message.parse(value),
    )
    let removeListener: (() => void) | undefined
    const stopServer = createPortServer(
      port.port,
      peerNamesProtocol,
      {
        peerNames: {
          exchange: async ({ shareId, sessionId, displayName }) => {
            const share = shares.get(shareId)
            const peerId = connection.remotePeer.toString()
            const session =
              share &&
              [...share.sessions].find(
                (candidate) => candidate.peerId === peerId && candidate.sessionId === sessionId,
              )
            if (!session || (expectedShareId !== undefined && shareId !== expectedShareId))
              throw new Error('Name access denied.')
            requireAuthorized(session, share)
            await receivePeerName(peerId, displayName)
            if (!removeListener) {
              const listener = (name: string | null) => {
                if (!share?.sessions.has(session)) return
                try {
                  requireAuthorized(session, shares.get(shareId))
                } catch {
                  return
                }
                port.port.send(
                  peerNamesProtocol.streams['peerNames.profile'].changed.parse({
                    type: 'changed',
                    displayName: name,
                  }),
                )
              }
              const listeners =
                nameListeners.get(peerId) ?? new Set<(name: string | null) => void>()
              listeners.add(listener)
              nameListeners.set(peerId, listeners)
              removeListener = () => {
                listeners.delete(listener)
                if (!listeners.size) nameListeners.delete(peerId)
              }
            }
            return { displayName: namePreference(peerId).sharedName }
          },
        },
      },
      { onError: () => undefined },
    )
    void port.closed.then(() => {
      removeListener?.()
      stopServer()
    })
  }

  const startPeer = async () => {
    if (!peer) {
      publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
      peer = startPrivateBrowserPeer(privateKey)
        .then(async (started) => {
          await started.node.handle(SHARE_STREAM_PROTOCOL, handleIncomingStream, {
            runOnLimitedConnection: true,
          })
          await started.node.handle(PEER_NAMES_PROTOCOL, handleNameStream, {
            runOnLimitedConnection: true,
          })
          await started.node.handle(DEVICE_COMPARISON_PROTOCOL, handleComparisonStream, {
            maxInboundStreams: 8,
            runOnLimitedConnection: true,
          })
          handlerNode = started.node
          publish({ peerStatus: 'online', message: '' })
          return started
        })
        .catch((error) => {
          peer = undefined
          publish({
            peerStatus: 'error',
            message: error instanceof Error ? error.message : 'P2P connection failed.',
          })
          throw error
        })
    }
    return peer
  }
  const startSourcePeer = (
    share: Pick<SourceShare, 'capability' | 'sourcePrivateKey'>,
  ): Promise<{ node: BrowserLibp2pNode; addresses: string[] }> => {
    if (!share.sourcePrivateKey) return startPeer()
    const shareId = share.capability.shareId
    const existing = sourceStarts.get(shareId)
    if (existing) return existing

    publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
    const starting = startPrivateBrowserPeer(share.sourcePrivateKey)
      .then(async (started) => {
        await started.node.handle(
          SHARE_STREAM_PROTOCOL,
          (stream, connection) => handleIncomingStream(stream, connection, shareId),
          { runOnLimitedConnection: true },
        )
        await started.node.handle(
          PEER_NAMES_PROTOCOL,
          (stream, connection) => handleNameStream(stream, connection, shareId),
          { runOnLimitedConnection: true },
        )
        await started.node.handle(
          DEVICE_COMPARISON_PROTOCOL,
          (stream, connection) => handleComparisonStream(stream, connection, shareId),
          { maxInboundStreams: 8, runOnLimitedConnection: true },
        )
        sourceNodes.set(shareId, started.node)
        publish({ peerStatus: 'online', message: '' })
        return started
      })
      .catch((error) => {
        sourceStarts.delete(shareId)
        publish({
          peerStatus: 'error',
          message: error instanceof Error ? error.message : 'P2P connection failed.',
        })
        throw error
      })
    sourceStarts.set(shareId, starting)
    return starting
  }

  const stopSourcePeer = async (shareId: string): Promise<void> => {
    const starting = sourceStarts.get(shareId)
    sourceStarts.delete(shareId)
    let node = sourceNodes.get(shareId)
    if (!node && starting) {
      try {
        node = (await starting).node
      } catch {
        return
      }
    }
    sourceNodes.delete(shareId)
    if (!node) return
    await node.unhandle(SHARE_STREAM_PROTOCOL).catch(() => undefined)
    await node.stop()
  }

  const pruneEndNotifications = (): string[] => {
    const retained = new Set(
      retainedEndNotifications([...endedShares.values()]).map((share) => share.capability.shareId),
    )
    const removed = [...endedShares.keys()].filter((shareId) => !retained.has(shareId))
    removed.forEach((shareId) => endedShares.delete(shareId))
    return removed
  }

  const rememberEndNotification = (
    share: SourceShare,
    reason: 'revoked' | 'expired',
    endedAt: number,
  ): void => {
    endedShares.set(share.capability.shareId, {
      capability: share.capability,
      url: share.url,
      sourcePrivateKey: share.sourcePrivateKey,
      publication: share.publication,
      capacity: share.capacity,
      approvedPeerId: share.approvedPeerId,
      reason,
      endedAt,
    })
  }

  const endFollowing = (
    shareId: string,
    reason: 'revoked' | 'expired',
    endedAt: number,
    name?: string,
  ): void => {
    const entry = followed.get(shareId)
    if (entry) {
      entry.connected = false
      entry.terminal = reason
      entry.endedAt = endedAt
    }
    received.delete(shareId)
    pendingReturns.delete(shareId)
    rememberLifecycleRecord(oldSeeing, {
      shareId,
      ...(entry?.peerId ? { peerId: entry.peerId } : {}),
      name: entry?.localName ?? name,
      reason,
      endedAt,
    })
  }

  const acceptPendingReturn = async (
    key: string,
    offer: SharingRuntimeState['returnOffers'][number],
  ): Promise<boolean> => {
    if (returnShareReceiver === 'external') return false
    const capability = parseShareInvitation(offer.url)
    if (
      hasEndedPeerShare(oldSeeing.values(), capability.shareId) ||
      followed.get(capability.shareId)?.terminal
    ) {
      throw new Error('This return location link has ended.')
    }
    await acceptReturnShare(runtime, offer, (shareId) => Boolean(followed.get(shareId)?.connected))
    if (returnOffers.get(key) !== offer) return false
    returnOffers.delete(key)
    try {
      await persist()
    } catch (error) {
      returnOffers.set(key, offer)
      throw error
    }
    publish()
    return true
  }

  const ensurePeer = async () => {
    await prepareState()
    return startPeer()
  }

  const updateShareLocation = (share: SourceShare, exact: LocationObservationV1): boolean => {
    if (sharePauseReason(share, networkRestriction)) return false
    if (share.precision === 'exact') {
      share.latest = exact
      return false
    }
    const projected = projectApproximateLocation(
      exact,
      share.approximation,
      undefined,
      share.precision === 'very-coarse' ? VERY_COARSE_RADIUS_METERS : undefined,
    )
    const changed =
      !share.approximation ||
      Object.entries(projected.state).some(
        ([key, value]) => value !== share.approximation?.[key as keyof ApproximationState],
      )
    share.approximation = projected.state
    share.latest = projected.observation
    return changed
  }

  const unsubscribeLocationState = locationSource.subscribeState((location) =>
    publish({ location }),
  )
  const unsubscribeLocationObservation = locationSource.subscribeObservation((exact) => {
    let privateStateChanged = false
    for (const share of shares.values()) {
      if (!visible && share.publication === 'foreground') continue
      if (updateShareLocation(share, exact)) privateStateChanged = true
      for (const session of share.sessions) {
        if (!session.subscriptionId || !share.latest) continue
        void encryptedObservationMessage(share, session.subscriptionId)
          .then((message) => {
            if (!message) return
            session.send(message)
          })
          .catch(() => publish({ message: 'Location encryption failed.' }))
      }
    }
    if (privateStateChanged) {
      void persist().catch(() => publish({ message: 'Private share state could not be saved.' }))
    }
  })

  const retryPendingStopNotices = async (): Promise<void> => {
    if (retryingStopNotices || runtimeClosed || !store || !privateStateAvailable) return
    retryingStopNotices = true
    try {
      // A bounded batch avoids monopolizing startup or draining the battery.
      for (const [id, pending] of [...pendingStopNotices].slice(0, 2)) {
        if (runtimeClosed) break
        if (Date.now() - pending.queuedAt >= STOP_NOTICE_RETENTION_MS) {
          pendingStopNotices.delete(id)
          try {
            await persist()
          } catch {
            pendingStopNotices.set(id, pending)
          }
          continue
        }
        try {
          // A queued notice contains only a narrow, precomputed stop proof.
          // No original bearer URL or location access secret is retained.
          const { node } = await ensurePeer()
          if (runtimeClosed) break
          if (node.peerId.toString() !== pending.viewerPeerId) {
            throw new Error('The stop notice belongs to a different local identity.')
          }
          const stream = await dialShareStream(
            node,
            pending.addresses,
            SHARE_STREAM_PROTOCOL,
            node
              .getConnections()
              .filter(
                (connection) =>
                  connection.status === 'open' &&
                  connection.remotePeer.toString() === pending.sourcePeerId,
              ),
          )
          const port = createProtocolMessagePort(stream, parseConstellationMessage)
          try {
            const client = createPortClient(port.port, constellationProtocolV2)
            await client.share.stopNotice({
              shareId: pending.shareId,
              eventId: pending.eventId,
              proof: pending.proof,
            })
          } finally {
            await port.close()
          }
          pendingStopNotices.delete(id)
          try {
            await persist()
          } catch {
            pendingStopNotices.set(id, pending)
          }
        } catch {
          // Rotate unsuccessful deliveries so unreachable links cannot starve others.
          rotatePendingNotice(pendingStopNotices, id)
        }
      }
    } finally {
      retryingStopNotices = false
    }
  }

  const heartbeatSweep = window.setInterval(() => {
    const now = Date.now()
    for (const share of shares.values()) {
      const expired = share.capability.expiresAt !== null && now >= share.capability.expiresAt
      for (const session of [...share.sessions]) {
        const reason = sessionSweepReason(share.capability.expiresAt, session.lastHeartbeatAt, now)
        if (reason) {
          if (reason === 'expired' && session.sessionId) {
            session.send(
              constellationProtocolV2.streams['share.sessions'].closed.parse({
                type: 'closed',
                sessionId: session.sessionId,
                reason: 'expired',
              }),
            )
          }
          removeSession(session, reason)
          void (reason === 'expired' ? session.closeAfterFlush() : session.close())
        }
      }
      if (expired) {
        const endedAt = share.capability.expiresAt ?? now
        rememberEndedShareHistory(
          {
            shareId: share.capability.shareId,
            name: share.name,
            viewerPeerIds: share.viewerPeerIds,
          },
          'expired',
          endedAt,
        )
        shares.delete(share.capability.shareId)
        rememberEndNotification(share, 'expired', endedAt)
        const prunedEndIds = pruneEndNotifications()
        if (!shares.size) locationSource.stop()
        approvedReturnLinks.delete(share.capability.shareId)
        for (const key of returnOffers.keys()) {
          if (key.startsWith(`${share.capability.shareId}:`)) returnOffers.delete(key)
        }
        for (const [key, request] of pendingViewerApprovals) {
          if (request.shareId === share.capability.shareId) pendingViewerApprovals.delete(key)
        }
        void Promise.all([persist(), ...prunedEndIds.map(stopSourcePeer)]).catch(() =>
          publish({ message: 'Expired share state could not be saved.' }),
        )
      }
    }

    const prunedEndIds = pruneEndNotifications()
    if (prunedEndIds.length) {
      void Promise.all([persist(), ...prunedEndIds.map(stopSourcePeer)]).catch(() =>
        publish({ message: 'Ended-link notice state could not be saved.' }),
      )
    }
    let pendingReturnStateChanged = false
    for (const [shareId, url] of pendingReturns) {
      const entry = followed.get(shareId)
      try {
        parseShareInvitation(url, now)
        if (entry && !entry.terminal && (entry.expiresAt === null || now < entry.expiresAt))
          continue
      } catch {
        // Expired return links cannot be delivered later.
      }
      pendingReturns.delete(shareId)
      pendingReturnStateChanged = true
    }
    for (const [shareId, entry] of followed) {
      if (
        entry.expiresAt !== null &&
        now >= entry.expiresAt &&
        entry.terminal !== 'expired' &&
        entry.terminal !== 'revoked'
      ) {
        endFollowing(shareId, 'expired', entry.expiresAt)
        void viewerClosers.get(shareId)?.()
        void persist()
        continue
      }
      if (returnShareReceiver === 'external') continue
      if (entry.connected || viewerClosers.has(shareId) || reconnecting.has(shareId)) continue
      if (entry.terminal || entry.approvalDenied) continue
      try {
        parseShareInvitation(entry.url, now)
      } catch {
        entry.terminal =
          entry.expiresAt !== null && now >= entry.expiresAt ? 'expired' : 'unavailable'
        if (entry.terminal === 'expired') {
          entry.endedAt = entry.expiresAt ?? now
          received.delete(shareId)
          rememberLifecycleRecord(oldSeeing, {
            shareId,
            ...(entry.peerId ? { peerId: entry.peerId } : {}),
            name: entry.localName,
            reason: 'expired',
            endedAt: entry.endedAt,
          })
          void persist()
        }
        continue
      }
      reconnecting.add(shareId)
      void runtime
        .acceptShare(entry.url, { localName: entry.localName, saved: entry.saved })
        .catch(() => undefined)
        .finally(() => reconnecting.delete(shareId))
    }
    if (pendingStopNotices.size && Date.now() >= stopRetryAt) {
      stopRetryAt = Date.now() + 30_000
      void retryPendingStopNotices()
    }
    if (pendingReturnStateChanged) void persist()
    publish()
  }, HEARTBEAT_INTERVAL_MS)

  const runtime: SharingRuntime = {
    signReturnOwnership: async (shareId, sourcePeerId) => {
      await prepareState()
      if (!privateKey || !privateStateAvailable) throw new Error('Owner identity is unavailable.')
      if (!shareId || !sourcePeerId) throw new Error('Invalid return share identity.')
      return {
        ownerPeerId: peerIdFromPrivateKey(privateKey).toString(),
        ownerProof: bytesToBase64Url(
          await privateKey.sign(returnOwnerMessage(shareId, sourcePeerId)),
        ),
      }
    },
    replaceBackgroundShareOwner: async (
      shareId,
      sourcePeerId,
      ownerPeerId,
      ownerProof,
      binding,
    ) => {
      await prepareState()
      const current = shares.get(shareId)
      if (!current || current.capability.sourcePeerId !== sourcePeerId) {
        throw new Error('Share is not available for ownership handoff.')
      }
      if (binding.mode === 'recipient') {
        if (current.publication !== 'background' || current.capacity !== 1) {
          throw new Error('Return share is not available for ownership handoff.')
        }
        if (binding.recipientPeerId === ownerPeerId || !binding.recipientPeerId) {
          throw new Error('Return share must be bound to a different authenticated recipient.')
        }
      }
      const capability = { ...current.capability, ownerPeerId, ownerProof }
      if (!(await verifyReturnOwner(capability, ownerPeerId))) {
        throw new Error('Invalid return ownership proof.')
      }
      // The native service may persist the handoff while the foreground
      // acknowledgement times out. An identical retry is a no-op.
      if (
        current.capability.ownerPeerId === ownerPeerId &&
        current.capability.ownerProof === ownerProof &&
        (binding.mode === 'source' || current.approvedPeerId === binding.recipientPeerId)
      ) {
        publish()
        return state.shares.find((share) => share.shareId === shareId)!
      }
      if (binding.mode === 'source') {
        if (
          !privateKey ||
          current.capability.ownerPeerId !== peerIdFromPrivateKey(privateKey).toString()
        ) {
          throw new Error('Source share ownership was already replaced.')
        }
        if (current.sessions.size > 0) {
          throw new Error('Source share is not available for ownership handoff.')
        }
      } else if (current.approvedPeerId || current.sessions.size > 0) {
        throw new Error('Return share is not available for ownership handoff.')
      }
      const next: SourceShare = {
        ...current,
        ...(binding.mode === 'recipient' ? { approvedPeerId: binding.recipientPeerId } : {}),
        capability,
        url: shareInvitationUrl(capability, current.url),
      }
      shares.set(shareId, next)
      try {
        await persist()
      } catch (error) {
        shares.set(shareId, current)
        throw error
      }
      publish()
      return state.shares.find((share) => share.shareId === shareId)!
    },
    importSourceShares: async (incoming) => {
      await prepareState()
      const active: SourceShare[] = [],
        ends: EndedSourceShare[] = []
      const expiredHistory: OldShareSummary[] = []
      for (const record of incoming.shares) {
        const capability = parseShareInvitation(record.url, 0)
        const sourcePrivateKey = record.sourcePrivateKey ?? incoming.privateKey
        if (capability.expiresAt !== null && capability.expiresAt <= Date.now()) {
          ends.push(
            restoredEndedSourceShare({
              ...record,
              sourcePrivateKey,
              reason: 'expired',
              endedAt: capability.expiresAt,
            }),
          )
          for (const peerId of record.viewerPeerIds?.length ? record.viewerPeerIds : [undefined])
            expiredHistory.push({
              shareId: capability.shareId,
              peerId,
              name: record.name,
              reason: 'expired',
              endedAt: capability.expiresAt,
            })
        } else active.push(restoredSourceShare({ ...record, sourcePrivateKey }, sharingBehavior))
      }
      ends.push(
        ...retainedEndNotifications(incoming.endedShares ?? []).map((record) =>
          restoredEndedSourceShare({
            ...record,
            sourcePrivateKey: record.sourcePrivateKey ?? incoming.privateKey,
          }),
        ),
      )
      for (const share of [...active, ...ends]) {
        if (
          !share.sourcePrivateKey ||
          peerIdFromPrivateKey(share.sourcePrivateKey).toString() !== share.capability.sourcePeerId
        )
          throw new Error('The imported source identity does not match its link.')
      }
      const owned = new Set([...active, ...ends].map((share) => share.capability.shareId))
      const rollback = [
        insertImportedEntries(
          endedShares,
          ends
            .filter((share) => !shares.has(share.capability.shareId))
            .map((share) => [share.capability.shareId, share]),
        ),
        insertImportedEntries(
          shares,
          active
            .filter((share) => !endedShares.has(share.capability.shareId))
            .map((share) => [share.capability.shareId, share]),
        ),
        insertImportedEntries(
          viewerLabels,
          (incoming.viewerLabels ?? [])
            .filter((record) => owned.has(record.shareId))
            .map((record) => [`${record.shareId}:${record.fingerprint}`, record.name]),
        ),
        insertImportedEntries(
          peerNamePreferences,
          (incoming.peerNamePreferences ?? []).map((record) => [record.peerId, record]),
        ),
        insertImportedEntries(
          oldSharing,
          [...(incoming.oldSharing ?? []), ...expiredHistory].map((record) => [
            JSON.stringify([record.shareId, record.peerId ?? null]),
            record,
          ]),
        ),
        insertImportedEntries(
          stoppedViewers,
          (incoming.stoppedViewers ?? []).map((record) => [
            stoppedViewerKey(record.shareId, record.peerId),
            record,
          ]),
        ),
        insertImportedEntries(
          returnOffers,
          (incoming.returnOffers ?? [])
            .filter((record) => owned.has(record.shareId))
            .map((record) => [`${record.shareId}:${record.viewerFingerprint}`, record]),
        ),
        insertImportedEntries(
          deviceComparisons,
          (incoming.deviceComparisons ?? [])
            .filter((record) => record.role === 'sender' && owned.has(record.shareId))
            .map((record) => [record.challenge, record]),
        ),
      ]
      const approvals = (incoming.approvedReturnLinks ?? []).filter(
        (id) => owned.has(id) && !approvedReturnLinks.has(id),
      )
      approvals.forEach((id) => approvedReturnLinks.add(id))
      const budgets = (incoming.comparisonBudgets ?? []).filter(
        (record) =>
          owned.has(record.shareId) &&
          !comparisonBudgets.some(
            (current) =>
              current.shareId === record.shareId && current.ownPeerId === record.ownPeerId,
          ),
      )
      comparisonBudgets.push(...budgets)
      try {
        parsePrivateState(snapshot())
        await persist()
      } catch (error) {
        rollback.forEach((undo) => undo())
        approvals.forEach((id) => approvedReturnLinks.delete(id))
        for (const budget of budgets) {
          const index = comparisonBudgets.indexOf(budget)
          if (index !== -1) comparisonBudgets.splice(index, 1)
        }
        publish()
        throw error
      }
      publish()
    },
    setSharingBehavior: async (requested) => {
      await prepareState()
      if (pendingSharingBehavior) throw new Error('Wait for the previous settings update.')
      const next = SharingBehavior.parse(requested)
      pendingSharingBehavior = next
      try {
        await persist()
      } catch (error) {
        pendingSharingBehavior = undefined
        // Repair later queued snapshots containing the attempted policy without dropping events.
        await persist().catch(() => undefined)
        publish()
        throw error
      }
      sharingBehavior = next
      pendingSharingBehavior = undefined
      for (const share of shares.values()) {
        share.publication = next.publication
        Object.assign(share, backgroundSharePolicy(next.publication, next.battery, next.network))
      }
      if (next.publication === 'foreground' && !visible) {
        for (const share of shares.values()) share.latest = undefined
        locationSource.stop()
      } else if (shares.size) locationSource.start()
      publish()
    },
    clearOldPeers: async (protection) => {
      await prepareState()
      const own = protectActivePeerHistory(state.shares, state.following)
      const protectedHistory = {
        peerIds: [
          ...new Set([
            ...protection.peerIds,
            ...own.peerIds,
            ...[...pendingViewerApprovals.values()].map((request) => request.peerId),
            ...[...returnOffers.values()].map((offer) => offer.ownerPeerId),
          ]),
        ],
        shareIds: [...new Set([...protection.shareIds, ...own.shareIds])],
      }
      const previousSharing = new Map(oldSharing)
      const previousSeeing = new Map(oldSeeing)
      const previousStopped = new Map(stoppedViewers)
      const nextSharing = clearPeerHistory(oldSharing, protectedHistory)
      const nextSeeing = clearPeerHistory(oldSeeing, protectedHistory)
      const nextStopped = clearPeerHistory(stoppedViewers, protectedHistory)
      applyHistoryRecords(oldSharing, nextSharing)
      applyHistoryRecords(oldSeeing, nextSeeing)
      applyHistoryRecords(stoppedViewers, nextStopped)
      try {
        await persist()
      } catch (error) {
        applyHistoryRecords(
          oldSharing,
          restoreFailedPeerHistoryClear(oldSharing, previousSharing, nextSharing),
        )
        applyHistoryRecords(
          oldSeeing,
          restoreFailedPeerHistoryClear(oldSeeing, previousSeeing, nextSeeing),
        )
        applyHistoryRecords(
          stoppedViewers,
          restoreFailedPeerHistoryClear(stoppedViewers, previousStopped, nextStopped),
        )
        // Preserve newer events; repair any later queued snapshot carrying the attempted clear.
        await persist().catch(() => undefined)
        publish()
        throw error
      }
      publish({ message: 'Unused ended entries cleared. Pending notices are kept.' })
    },
    dismissStoppedViewer: async (shareId, peerId) => {
      await prepareState()
      const key = stoppedViewerKey(shareId, peerId)
      const current = stoppedViewers.get(key)
      if (!current || current.dismissed) return
      stoppedViewers.set(key, { ...current, dismissed: true })
      try {
        await persist()
      } catch (error) {
        stoppedViewers.set(key, current)
        throw error
      }
      publish()
    },
    offerReturnShare: async (followShareId, url, options = {}) => {
      await prepareState()
      const follow = followed.get(followShareId)
      if (!follow || follow.terminal || hasEndedPeerShare(oldSeeing.values(), followShareId)) {
        throw new Error('This location is no longer followed.')
      }
      const capability = parseShareInvitation(url)
      const { node } = await ensurePeer()
      if (!(await verifyReturnOwner(capability, node.peerId.toString()))) {
        throw new Error('This return link cannot prove which viewer created it.')
      }
      const originalCapability = parseShareInvitation(follow.url)
      if (!originalCapability.ownerPeerId || !(await verifyReturnOwner(originalCapability))) {
        throw new Error('This location link cannot verify the original sharer identity.')
      }
      const returnShare = shares.get(capability.shareId)
      if (returnShare) {
        if (returnShare.capacity !== 1) {
          throw new Error('The return link is not a single-recipient share.')
        }
        if (
          returnShare.approvedPeerId &&
          returnShare.approvedPeerId !== originalCapability.ownerPeerId
        ) {
          throw new Error('The return link is already bound to another peer.')
        }
        const previousApprovedPeerId = returnShare.approvedPeerId
        returnShare.approvedPeerId = originalCapability.ownerPeerId
        try {
          await persist()
        } catch (error) {
          returnShare.approvedPeerId = previousApprovedPeerId
          throw error
        }
      } else if (options.externalBoundRecipientPeerId !== originalCapability.ownerPeerId) {
        throw new Error('The background return link is not bound to the original sharer.')
      }
      publish()
      const send = returnSenders.get(followShareId)
      if (send) {
        await send(url)
        return
      }
      pendingReturns.set(followShareId, url)
      try {
        await persist()
      } catch (error) {
        pendingReturns.delete(followShareId)
        throw error
      }
      publish({ message: 'Return link queued until the original sharer reconnects.' })
    },
    dismissReturnOffer: async (shareId, fingerprint) => {
      const key = `${shareId}:${fingerprint}`
      const offer = returnOffers.get(key)
      if (!offer) return
      returnOffers.delete(key)
      try {
        await persist()
      } catch (error) {
        returnOffers.set(key, offer)
        throw error
      }
      publish()
    },
    approveReturnLink: async (shareId) => {
      await prepareState()
      if (!shares.has(shareId)) throw new Error('This share is no longer active.')
      const wasApproved = approvedReturnLinks.has(shareId)
      approvedReturnLinks.add(shareId)
      try {
        await persist()
      } catch (error) {
        if (!wasApproved) approvedReturnLinks.delete(shareId)
        throw error
      }
      publish({ message: 'Share-back permission saved. Waiting for location.' })
      // Receiving a return location is network-dependent. It must not delay or undo
      // the already-persisted permission decision.
      const pending = [...returnOffers.entries()].filter(([, offer]) => offer.shareId === shareId)
      void Promise.all(
        pending.map(async ([key, offer]) => {
          try {
            await acceptPendingReturn(key, offer)
          } catch {
            publish({
              message:
                'Permission saved. A return location is still pending; retry when connected.',
            })
          }
        }),
      )
    },
    startDeviceComparison: async (shareId) => {
      await prepareState()
      const follow = followed.get(shareId)
      if (
        !store ||
        !privateStateAvailable ||
        !follow ||
        follow.terminal ||
        follow.approvalDenied ||
        comparisonRuns.has(shareId)
      )
        throw new Error('Device comparison is unavailable.')
      const capability = parseShareInvitation(follow.url)
      const { node } = await ensurePeer()
      const ownPeerId = node.peerId.toString()
      const run: { cancelled: boolean; close?: () => Promise<void> } = { cancelled: false }
      comparisonRuns.set(shareId, run)
      try {
        await reserveDeviceComparison(shareId, ownPeerId)
        const stream = await dialShareStream(
          node,
          capability.addresses,
          DEVICE_COMPARISON_PROTOCOL,
          node
            .getConnections()
            .filter(
              (connection) =>
                connection.status === 'open' &&
                connection.remotePeer.toString() === capability.sourcePeerId,
            ),
        )
        try {
          requireComparisonStreamPeer(stream, node.getConnections(), capability.sourcePeerId)
        } catch (error) {
          stream.abort(error instanceof Error ? error : new Error('Device comparison denied.'))
          throw error
        }
        const port = createProtocolMessagePort(stream, (value) =>
          deviceComparisonProtocol.message.parse(value),
        )
        run.close = () => port.close()
        const client = createPortClient(port.port, deviceComparisonProtocol)
        try {
          if (run.cancelled) throw new Error('Device comparison cancelled.')
          const binding = {
            shareId,
            sourcePeerId: capability.sourcePeerId,
            viewerPeerId: ownPeerId,
          }
          const secret = base64UrlToBytes(capability.secret)
          const commit = await createComparisonCommit(secret, binding)
          const result = await finishComparison(
            secret,
            binding,
            commit,
            await client.comparison.commit(commit.request),
            (request) => client.comparison.reveal(request),
          )
          if (
            run.cancelled ||
            Date.now() >= result.expiresAt ||
            result.expiresAt > Date.now() + COMPARISON_TTL_MS ||
            followed.get(shareId) !== follow
          )
            throw new Error('Device comparison expired or cancelled.')
          for (const [key, entry] of deviceComparisons)
            if (entry.shareId === shareId) deviceComparisons.delete(key)
          deviceComparisons.set(result.challenge, {
            ...result,
            shareId,
            peerId: capability.sourcePeerId,
            ownPeerId,
            role: 'viewer',
          })
          publish()
        } finally {
          await port.close()
        }
      } finally {
        comparisonRuns.delete(shareId)
      }
    },
    confirmDeviceComparison: async (shareId, challenge) => {
      await prepareState()
      const entry = deviceComparisons.get(challenge)
      if (
        !entry ||
        entry.shareId !== shareId ||
        !comparisonIsCurrent(entry) ||
        Date.now() >= entry.expiresAt
      )
        throw new Error('Device comparison expired or cancelled.')
      if (
        entry.role === 'viewer' &&
        (await ensurePeer()).node.peerId.toString() !== entry.ownPeerId
      )
        throw new Error('Device identity changed.')
      const next = { ...entry, confirmedAt: Date.now() }
      deviceComparisons.set(challenge, next)
      try {
        await persist()
      } catch (error) {
        deviceComparisons.set(challenge, entry)
        throw error
      }
      publish()
    },
    cancelDeviceComparison: async (shareId, challenge) => {
      await prepareState()
      const run = comparisonRuns.get(shareId)
      if (run) {
        run.cancelled = true
        await run.close?.()
      }
      const entry = deviceComparisons.get(challenge)
      if (entry?.shareId === shareId) deviceComparisons.delete(challenge)
      await persist()
      publish()
    },
    approveViewer: async (shareId, peerId) => {
      await prepareState()
      const share = shares.get(shareId)
      const key = viewerApprovalKey(shareId, peerId)
      if (!share || share.capacity !== 1) {
        throw new Error('This is not an active single-recipient share.')
      }
      if (!pendingViewerApprovals.has(key)) {
        throw new Error('This device is no longer waiting for approval.')
      }
      if (share.approvedPeerId && share.approvedPeerId !== peerId) {
        throw new Error('Another device is already approved for this share.')
      }
      const previousPeerId = share.approvedPeerId
      share.approvedPeerId = peerId
      try {
        await persist()
      } catch (error) {
        share.approvedPeerId = previousPeerId
        throw error
      }
      pendingViewerApprovals.delete(key)
      publish({ message: 'This device can now view your location.' })
    },
    markReturnPromptSeen: async (shareId) => {
      await prepareState()
      const entry = followed.get(shareId)
      if (!entry || entry.returnPromptSeen) return
      entry.returnPromptSeen = true
      await persist()
      publish()
    },
    setPeerNamePreferences: async (peerId, associateNames, sharedName) => {
      await prepareState()
      const known =
        [...followed.values()].some((entry) => entry.peerId === peerId) ||
        [...shares.values()].some((share) =>
          [...share.sessions].some((session) => session.peerId === peerId),
        )
      if (!known) throw new Error('This peer has no authenticated location relationship.')
      if (!store || !privateStateAvailable) throw new Error('Protected storage is unavailable.')
      if (peerNamePreferences.size >= 1_024 && !peerNamePreferences.has(peerId))
        throw new Error('Too many remembered peers.')
      const previous = namePreference(peerId)
      const next = PeerNamePreference.parse({ ...previous, associateNames, sharedName })
      peerNamePreferences.set(peerId, next)
      try {
        await persist()
      } catch (error) {
        peerNamePreferences.set(peerId, previous)
        throw error
      }
      nameListeners.get(peerId)?.forEach((send) => send(next.sharedName))
      const results = await Promise.allSettled(
        [...followed.entries()]
          .filter(([, entry]) => entry.peerId === peerId)
          .flatMap(([shareId]) => {
            const sender = nameSenders.get(shareId)
            return sender ? [sender.send(next.sharedName)] : []
          }),
      )
      publish()
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Name preference saved; delivery will retry when this peer reconnects.')
    },
    adoptPeerName: async (peerId, name) => {
      await prepareState()
      const previous = peerNamePreferences.get(peerId)
      const entries = [...followed.values()].filter((entry) => entry.peerId === peerId)
      const linkName = entries.find((entry) => entry.sourceName)?.sourceName
      if (advertisedPeerName(previous, linkName) !== name) {
        throw new Error('The advertised name changed. Review the latest name and retry.')
      }
      const previousEntries = entries.map((entry) => ({
        entry,
        localName: entry.localName,
        usesPrivateName: entry.usesPrivateName,
      }))
      const labelKeys = await Promise.all(
        [...shares.keys()].map(
          async (shareId) => `${shareId}:${await viewerFingerprint(shareId, peerId)}`,
        ),
      )
      const previousLabels = labelKeys.map((key) => ({ key, name: viewerLabels.get(key) }))
      if (advertisedPeerName(peerNamePreferences.get(peerId), linkName) !== name)
        throw new Error('The advertised name changed. Review the latest name and retry.')
      peerNamePreferences.set(peerId, {
        ...namePreference(peerId),
        acceptedName: name,
        nickname: undefined,
      })
      entries.forEach((entry) => {
        entry.localName = name
        entry.usesPrivateName = false
      })
      labelKeys.forEach((key) => viewerLabels.delete(key))
      try {
        await persist()
      } catch (error) {
        if (previous) peerNamePreferences.set(peerId, previous)
        else peerNamePreferences.delete(peerId)
        previousEntries.forEach(({ entry, localName, usesPrivateName }) => {
          entry.localName = localName
          entry.usesPrivateName = usesPrivateName
        })
        previousLabels.forEach(({ key, name }) => {
          if (name) viewerLabels.set(key, name)
        })
        publish()
        throw error
      }
      publish()
    },
    getViewerLabel: (shareId, fingerprint) => viewerLabels.get(`${shareId}:${fingerprint}`),
    setViewerLabel: async (shareId, fingerprint, name) => {
      await prepareState()
      const key = `${shareId}:${fingerprint}`
      const previous = viewerLabels.get(key)
      const next = name.trim().slice(0, 32)
      if (next) viewerLabels.set(key, next)
      else viewerLabels.delete(key)
      if (viewerLabels.size > 1_024) {
        if (previous) viewerLabels.set(key, previous)
        else viewerLabels.delete(key)
        throw new Error('Too many saved device names.')
      }
      try {
        await persist()
      } catch (error) {
        if (previous) viewerLabels.set(key, previous)
        else viewerLabels.delete(key)
        throw error
      }
      publish()
    },
    blockViewer: async (shareId, fingerprint) => {
      await prepareState()
      const share = shares.get(shareId)
      if (!share) throw new Error('This share is no longer available.')
      const sessions = [...share.sessions].filter((session) => session.fingerprint === fingerprint)
      const pending = [...pendingViewerApprovals.entries()].filter(
        ([, request]) => request.shareId === shareId && request.fingerprint === fingerprint,
      )
      const peerIds = [
        ...new Set([
          ...sessions.map((session) => session.peerId),
          ...pending.map(([, request]) => request.peerId),
        ]),
      ]
      if (peerIds.length === 0) throw new Error('This device is no longer connected.')
      if (share.blockedPeerIds.size + peerIds.length > 128) {
        throw new Error('Too many blocked devices on this link; revoke the link instead.')
      }
      for (const peerId of peerIds) share.blockedPeerIds.add(peerId)
      try {
        await persist()
      } catch (error) {
        for (const peerId of peerIds) share.blockedPeerIds.delete(peerId)
        throw error
      }
      for (const session of sessions) {
        share.sessions.delete(session)
        if (session.sessionId) {
          session.send(
            constellationProtocolV2.streams['share.sessions'].closed.parse({
              type: 'closed',
              sessionId: session.sessionId,
              reason: 'revoked',
            }),
          )
        }
      }
      pending.forEach(([key]) => pendingViewerApprovals.delete(key))
      recordSessionEvent('blocked')
      publish()
      await Promise.all(sessions.map((session) => session.closeAfterFlush()))
    },
    setNetworkState: (restriction) => {
      if (restriction === networkRestriction) return
      networkRestriction = restriction
      publish()
    },
    networkDiagnostics: () => ({
      peerStatus: state.peerStatus,
      sessionEvents,
      connections: [
        ...new Set([...(handlerNode ? [handlerNode] : []), ...sourceNodes.values()]),
      ].flatMap((node) =>
        node.getConnections().map((connection) => {
          const peerId = connection.remotePeer.toString()
          const address = connection.remoteAddr.toString()
          const viewer = [...shares.values()].some((share) =>
            [...share.sessions].some((session) => session.peerId === peerId),
          )
          const source = [...followed.values()].some((entry) => entry.sourcePeerId === peerId)
          let role: NetworkDiagnostics['connections'][number]['role'] = 'other peer'
          if (viewer) role = 'viewer'
          else if (source) role = 'source'
          return {
            role,
            transport: classifyTransport(address),
            direction: connection.direction,
            status: connection.status,
            peerId,
            remoteAddress: address,
            ...(connection.timeline.open ? { connectedAt: connection.timeline.open } : {}),
          }
        }),
      ),
    }),
    initialize: async () => {
      await prepareState()
      if (pendingStopNotices.size) void retryPendingStopNotices()
      if (shares.size > 0 || endedShares.size > 0) {
        const restoredShares = [...shares.values(), ...endedShares.values()]
        if (restoredShares.some((share) => !share.sourcePrivateKey)) await startPeer()
        await Promise.all(
          restoredShares
            .filter((share) => share.sourcePrivateKey)
            .map((share) => startSourcePeer(share)),
        )
        if (
          shares.size &&
          (visible || [...shares.values()].some((share) => share.publication === 'background'))
        ) {
          locationSource.start()
        }
      }
      const pending = [...followed.values()].filter(
        (entry) => returnShareReceiver === 'local' && !entry.connected && !entry.terminal,
      )
      void Promise.allSettled(
        pending.map((entry) =>
          runtime.acceptShare(entry.url, { localName: entry.localName, saved: entry.saved }),
        ),
      )
    },
    subscribe: (observer) => {
      observers.add(observer)
      observer(state)
      return () => observers.delete(observer)
    },
    createShare: async (
      draft,
      expiresAt = shareExpiryFor(draft, Date.now()),
      linkBaseUrl = shareBaseUrl,
    ) => {
      await prepareState()
      if (sharingBehavior) draft = { ...draft, ...sharingBehavior }
      publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
      const sourcePrivateKey = await generateKeyPair('Ed25519')
      const started = await startPrivateBrowserPeer(sourcePrivateKey)
      const invitation = await createShareInvitation({
        baseUrl: linkBaseUrl,
        sourcePeerId: started.node.peerId.toString(),
        addresses: started.addresses,
        expiresAt,
        ownerPrivateKey: privateKey,
      })
      const share: SourceShare = {
        capability: invitation.capability,
        url: invitation.url,
        secret: base64UrlToBytes(invitation.capability.secret),
        sourcePrivateKey,
        precision: draft.precision,
        capacity: capacityFor(draft),
        requireViewerApproval: draft.requireViewerApproval !== false,
        ...(draft.name ? { name: draft.name } : {}),
        publication: draft.publication,
        ...backgroundSharePolicy(draft.publication, draft.battery, draft.network),
        sessions: new Set(),
        viewerPeerIds: new Set(),
        redeemedNonces: new Set(),
        blockedPeerIds: new Set(),
      }
      shares.set(share.capability.shareId, share)
      try {
        await started.node.handle(
          SHARE_STREAM_PROTOCOL,
          (stream, connection) =>
            handleIncomingStream(stream, connection, share.capability.shareId),
          { runOnLimitedConnection: true },
        )
        await started.node.handle(
          PEER_NAMES_PROTOCOL,
          (stream, connection) => handleNameStream(stream, connection, share.capability.shareId),
          { runOnLimitedConnection: true },
        )
        await started.node.handle(
          DEVICE_COMPARISON_PROTOCOL,
          (stream, connection) =>
            handleComparisonStream(stream, connection, share.capability.shareId),
          { maxInboundStreams: 8, runOnLimitedConnection: true },
        )
        sourceNodes.set(share.capability.shareId, started.node)
        sourceStarts.set(share.capability.shareId, Promise.resolve(started))
        publish({ peerStatus: 'online', message: '' })
      } catch (error) {
        shares.delete(share.capability.shareId)
        await started.node.stop()
        throw error
      }
      const currentLocation = locationSource.getState()
      if (
        (currentLocation.status === 'live' || currentLocation.status === 'delayed') &&
        currentLocation.observation.expiresAt > Date.now()
      ) {
        updateShareLocation(share, currentLocation.observation)
      }
      try {
        await persist()
      } catch (error) {
        shares.delete(share.capability.shareId)
        await stopSourcePeer(share.capability.shareId)
        throw error
      }
      if (visible || draft.publication === 'background') locationSource.start()
      publish()
      return state.shares.find(({ shareId }) => shareId === share.capability.shareId)!
    },
    acceptShare: async (url, options = {}) => {
      if (returnShareReceiver === 'external') {
        throw new Error('Returned locations belong to the foreground receiver.')
      }
      if (!store && options.saved !== false) {
        throw new Error('Protected storage is not configured; preview only.')
      }
      await prepareState()
      const capability = parseShareInvitation(url)
      const knownPeerId =
        capability.ownerPeerId && (await verifyReturnOwner(capability))
          ? capability.ownerPeerId
          : undefined
      if (
        followed.get(capability.shareId)?.terminal ||
        hasEndedPeerShare(oldSeeing.values(), capability.shareId)
      ) {
        throw new Error('This location link has ended.')
      }
      if (
        options.returnOwnerPeerId &&
        !(await verifyReturnOwner(capability, options.returnOwnerPeerId))
      ) {
        throw new Error('This return link was not created by the connected viewer.')
      }
      if (followed.get(capability.shareId)?.connected) {
        throw new Error('Already following this link.')
      }
      const { node } = await ensurePeer()
      const existingConnections = node
        .getConnections()
        .filter(
          (connection) =>
            connection.status === 'open' &&
            connection.remotePeer.toString() === capability.sourcePeerId,
        )
      const stream = await dialShareStream(
        node,
        capability.addresses,
        SHARE_STREAM_PROTOCOL,
        existingConnections,
      )
      const messagePort = createProtocolMessagePort(stream, parseConstellationMessage)
      const client = createPortClient(messagePort.port, constellationProtocolV2)
      const previousFollow = followed.get(capability.shareId)
      const previousObservation = received.get(capability.shareId)
      let earlyClosedMessage: ConstellationMessage | undefined
      const stopBufferingClose = messagePort.port.receive((message) => {
        if (constellationProtocolV2.streams['share.sessions'].closed.safeParse(message).success)
          earlyClosedMessage = message
      })
      try {
        const viewerNonce = randomToken()
        const session = await client.share.redeem({
          shareId: capability.shareId,
          viewerNonce,
          proof: await createRedemptionProof(base64UrlToBytes(capability.secret), {
            shareId: capability.shareId,
            sourcePeerId: capability.sourcePeerId,
            viewerPeerId: node.peerId.toString(),
            viewerNonce,
          }),
        })
        if ('ended' in session) {
          endFollowing(
            capability.shareId,
            session.reason,
            session.endedAt,
            options.localName ?? generatedFollowName(capability.shareId),
          )
          await persist()
          await messagePort.close()
          publish({
            message:
              session.reason === 'revoked'
                ? 'The sender revoked this location link.'
                : 'This location link expired.',
          })
          throw new Error('This location link has ended.')
        }
        if ('approvalPending' in session || 'accessDenied' in session) {
          const existing = followed.get(capability.shareId)
          const existingPeer = [...followed.values()].find(
            (entry) => entry.sourcePeerId === capability.sourcePeerId,
          )
          const denied = 'accessDenied' in session
          followed.set(capability.shareId, {
            url,
            sourcePeerId: capability.sourcePeerId,
            peerId: knownPeerId,
            sourceName: existing?.sourceName,
            linkSourceName: existing?.linkSourceName,
            usesPrivateName: existing?.usesPrivateName ?? Boolean(options.localName?.trim()),
            localName:
              existing?.localName ??
              (options.localName?.trim() || generatedFollowName(capability.shareId)),
            color:
              existing?.color ??
              existingPeer?.color ??
              FOLLOW_COLORS[followed.size % FOLLOW_COLORS.length]!,
            connected: false,
            approvalPending: !denied,
            approvalDenied: denied,
            saved: existing?.saved ?? options.saved ?? true,
            followedAt: existing?.followedAt ?? Date.now(),
            returnPromptSeen: existing?.returnPromptSeen ?? Boolean(options.returnOwnerPeerId),
            updatesReceived: existing?.updatesReceived ?? 0,
            expiresAt: capability.expiresAt,
          })
          if (denied) received.delete(capability.shareId)
          if (followed.get(capability.shareId)?.saved) await persist()
          await messagePort.close()
          publish({
            message: denied
              ? 'The sender did not approve this device for the location share.'
              : 'Waiting for the sender to approve this device.',
          })
          return
        }
        const existing = followed.get(capability.shareId)
        const existingPeer = [...followed.values()].find(
          (entry) => entry.sourcePeerId === capability.sourcePeerId,
        )
        followed.set(capability.shareId, {
          url,
          sourcePeerId: capability.sourcePeerId,
          peerId: knownPeerId,
          sourceName: session.sourceName,
          linkSourceName: session.sourceName,
          usesPrivateName: existing?.usesPrivateName ?? Boolean(options.localName?.trim()),
          localName: nameAfterContact(
            existing,
            session.sourceName,
            existing ? undefined : options.localName,
            generatedFollowName(capability.shareId),
          ),
          color:
            existing?.color ??
            existingPeer?.color ??
            FOLLOW_COLORS[followed.size % FOLLOW_COLORS.length]!,
          connected: true,
          approvalPending: false,
          approvalDenied: false,
          saved: existing?.saved ?? options.saved ?? true,
          followedAt: existing ? existing.followedAt : Date.now(),
          returnPromptSeen: existing?.returnPromptSeen ?? Boolean(options.returnOwnerPeerId),
          updatesReceived: existing?.updatesReceived ?? 0,
          expiresAt: capability.expiresAt,
        })
        const activeSubscription: { id?: string } = {}
        let pendingObservation: unknown
        let awaitingFirstObservation = true
        const receiveObservation = async (envelope: {
          sequence: number
          capturedAt: number
          expiresAt: number
          payload: unknown
        }): Promise<void> => {
          try {
            const observation = await decryptLocationPayload(
              base64UrlToBytes(capability.secret),
              capability.shareId,
              envelope.payload,
            )
            if (
              observation.sequence !== envelope.sequence ||
              observation.capturedAt !== envelope.capturedAt ||
              observation.expiresAt !== envelope.expiresAt
            ) {
              throw new Error('Location envelope metadata does not match its encrypted payload.')
            }
            const current = received.get(capability.shareId)
            const newSource = awaitingFirstObservation && current?.sourceId !== observation.sourceId
            if (!newSource && !acceptNewerLocationObservation(current, observation)) {
              return
            }
            awaitingFirstObservation = false
            received.set(capability.shareId, observation)
            const entry = followed.get(capability.shareId)
            if (entry) entry.updatesReceived += 1
            publish({ message: '' })
          } catch {
            // Invalid or unauthenticated location payloads are ignored without retaining their data.
          }
        }
        const receiveMessage = (message: ConstellationMessage): void => {
          const closed = constellationProtocolV2.streams['share.sessions'].closed.safeParse(message)
          if (closed.success && closed.data.sessionId === session.sessionId) {
            const entry = followed.get(capability.shareId)
            if (entry) {
              entry.connected = false
              if (closed.data.reason === 'expired' || closed.data.reason === 'revoked') {
                entry.terminal = closed.data.reason
              }
            }
            if (entry && (entry.terminal === 'expired' || entry.terminal === 'revoked')) {
              endFollowing(
                capability.shareId,
                entry.terminal,
                entry.terminal === 'expired' ? (entry.expiresAt ?? Date.now()) : Date.now(),
              )
              void persist().catch(() =>
                publish({ message: 'Ended location history could not be saved.' }),
              )
            }
            publish({
              message:
                closed.data.reason === 'expired'
                  ? 'This location link expired.'
                  : closed.data.reason === 'revoked'
                    ? 'The sender revoked your access to this location.'
                    : 'The location connection closed. Reconnecting…',
            })
            void messagePort.close()
            return
          }
          const parsed =
            constellationProtocolV2.streams['sensor.observations'].observation.safeParse(message)
          if (!parsed.success) return
          if (!activeSubscription.id) {
            pendingObservation = parsed.data
            return
          }
          if (parsed.data.subscriptionId === activeSubscription.id) {
            void receiveObservation(parsed.data.observation)
          }
        }
        const unsubscribe = messagePort.port.receive(receiveMessage)
        stopBufferingClose()
        if (earlyClosedMessage) receiveMessage(earlyClosedMessage)
        if (hasEndedPeerShare(oldSeeing.values(), capability.shareId)) {
          unsubscribe()
          throw new Error('This location link has ended.')
        }
        await client.sensor.describe({ sensorId: LOCATION_SENSOR_ID })
        const subscription = await client.sensor.subscribe({
          sensorId: LOCATION_SENSOR_ID,
        })
        activeSubscription.id = subscription.subscriptionId
        const pending =
          constellationProtocolV2.streams['sensor.observations'].observation.safeParse(
            pendingObservation,
          )
        if (pending.success && pending.data.subscriptionId === activeSubscription.id) {
          await receiveObservation(pending.data.observation)
        }
        const heartbeat = window.setInterval(() => {
          void client.share.heartbeat({ sessionId: session.sessionId }).catch(() => {
            recordSessionEvent('heartbeat-failed')
            const entry = followed.get(capability.shareId)
            if (entry) entry.connected = false
            publish({ message: 'The location connection was lost.' })
            void messagePort.close()
          })
        }, session.heartbeatIntervalMs)
        const close = async (explicit = false, eventId?: string): Promise<boolean> => {
          window.clearInterval(heartbeat)
          unsubscribe()
          try {
            if (explicit) {
              await client.share.stopFollowing({
                sessionId: session.sessionId,
                eventId: eventId ?? randomToken(),
              })
            } else {
              await client.share.leave({ sessionId: session.sessionId })
            }
            return true
          } catch {
            return false
          } finally {
            await messagePort.close()
          }
        }
        viewerClosers.set(capability.shareId, close)
        returnSenders.set(capability.shareId, (url) =>
          client.share.offerReturn({
            sessionId: session.sessionId,
            url,
            ownerPeerId: node.peerId.toString(),
          }),
        )
        if (knownPeerId) {
          try {
            const names = await dialShareStream(
              node,
              capability.addresses,
              PEER_NAMES_PROTOCOL,
              node
                .getConnections()
                .filter(
                  (connection) => connection.remotePeer.toString() === capability.sourcePeerId,
                ),
            )
            const namesPort = createProtocolMessagePort(names, (value) =>
              peerNamesProtocol.message.parse(value),
            )
            const namesClient = createPortClient(namesPort.port, peerNamesProtocol)
            const removeNames = namesPort.port.receive((message) => {
              const change =
                peerNamesProtocol.streams['peerNames.profile'].changed.safeParse(message)
              if (change.success) void receivePeerName(knownPeerId, change.data.displayName)
            })
            const send = async (displayName: string | null): Promise<void> => {
              const response = await namesClient.peerNames.exchange({
                shareId: capability.shareId,
                sessionId: session.sessionId,
                displayName,
              })
              await receivePeerName(knownPeerId, response.displayName)
            }
            const closeNames = async () => {
              removeNames()
              await namesPort.close()
            }
            nameSenders.set(capability.shareId, { send, close: closeNames })
            void messagePort.closed.then(() => {
              if (nameSenders.get(capability.shareId)?.close === closeNames)
                nameSenders.delete(capability.shareId)
              void closeNames()
            })
            await send(namePreference(knownPeerId).sharedName)
          } catch {
            // Older clients have no name capability. Location sharing remains usable.
          }
        }
        const queuedReturn = pendingReturns.get(capability.shareId)
        if (queuedReturn) {
          try {
            await returnSenders.get(capability.shareId)!(queuedReturn)
            pendingReturns.delete(capability.shareId)
            await persist()
          } catch {
            publish({ message: 'Return link is queued until the original sharer reconnects.' })
          }
        }
        try {
          if (followed.get(capability.shareId)?.saved) await persist()
        } catch (error) {
          viewerClosers.delete(capability.shareId)
          returnSenders.delete(capability.shareId)
          if (existing) followed.set(capability.shareId, existing)
          else followed.delete(capability.shareId)
          await close()
          throw error
        }
        void messagePort.closed.then((result) => {
          window.clearInterval(heartbeat)
          unsubscribe()
          if (viewerClosers.get(capability.shareId) !== close) return
          viewerClosers.delete(capability.shareId)
          returnSenders.delete(capability.shareId)
          const entry = followed.get(capability.shareId)
          if (entry) {
            entry.connected = false
            if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
              endFollowing(capability.shareId, 'expired', entry.expiresAt)
              void persist().catch(() =>
                publish({ message: 'Ended location history could not be saved.' }),
              )
            }
          }
          if (result.reason !== 'local') {
            recordSessionEvent('transport-closed')
            publish({ message: 'The location connection closed. Reconnecting…' })
          }
          publish()
        })
        publish({
          message: received.has(capability.shareId) ? '' : 'Waiting for the first location…',
        })
      } catch (error) {
        if (hasEndedPeerShare(oldSeeing.values(), capability.shareId)) {
          publish()
        } else {
          if (previousFollow) followed.set(capability.shareId, previousFollow)
          else followed.delete(capability.shareId)
          if (previousObservation) received.set(capability.shareId, previousObservation)
        }
        await messagePort.close()
        throw error
      } finally {
        stopBufferingClose()
      }
    },
    stopFollowing: async (shareId) => {
      const comparison = comparisonRuns.get(shareId)
      if (comparison) {
        comparison.cancelled = true
        await comparison.close?.()
      }
      const close = viewerClosers.get(shareId)
      const entry = followed.get(shareId)
      if (!entry) return
      const observation = received.get(shareId)
      const pendingReturn = pendingReturns.get(shareId)
      const eventId = randomToken()
      const shouldQueue = shouldQueueStopNotice(Boolean(store && privateKey), privateStateAvailable)
      const pending: PendingStopNotice | undefined =
        shouldQueue && privateKey
          ? await preparePendingStopNotice(
              entry.url,
              eventId,
              peerIdFromPrivateKey(privateKey).toString(),
            )
          : undefined
      const previousQueue = new Map(pendingStopNotices)
      if (pending) {
        pendingStopNotices.set(eventId, pending)
        while (pendingStopNotices.size > 128) {
          const oldest = pendingStopNotices.keys().next().value
          if (oldest) pendingStopNotices.delete(oldest)
        }
      }
      followed.delete(shareId)
      received.delete(shareId)
      pendingReturns.delete(shareId)
      try {
        if (shouldQueue || entry.saved) await persist()
      } catch (error) {
        followed.set(shareId, entry)
        if (observation) received.set(shareId, observation)
        if (pendingReturn) pendingReturns.set(shareId, pendingReturn)
        pendingStopNotices.clear()
        for (const [key, value] of previousQueue) pendingStopNotices.set(key, value)
        throw error
      }
      viewerClosers.delete(shareId)
      returnSenders.delete(shareId)
      dispatchStopDelivery(
        () => (close ? close(true, eventId) : Promise.resolve(false)),
        async (sent) => {
          if (sent && pending && pendingStopNotices.delete(eventId)) {
            try {
              await persist()
            } catch {
              pendingStopNotices.set(eventId, pending)
            }
          }
          if (!sent && shouldQueue) {
            // The durable queue survives. The sweep retries after a short delay
            // instead of immediately attempting another slow dial.
            stopRetryAt = Math.max(stopRetryAt, Date.now() + 10_000)
          }
        },
      )
      publish({
        message: shouldQueue
          ? 'Stopped following. The sender will be notified when reachable.'
          : 'Stopped following locally.',
      })
    },
    saveFollowing: async (shareId, localName) => {
      const entry = followed.get(shareId)
      if (!entry) throw new Error('This location is no longer available.')
      if (!store || !privateStateAvailable) {
        throw new Error('Protected storage is unavailable; preview only.')
      }
      const previousName = entry.localName
      const wasSaved = entry.saved
      const previousUsesPrivateName = entry.usesPrivateName
      entry.usesPrivateName =
        Boolean(localName.trim()) &&
        (entry.usesPrivateName === true || localName.trim() !== entry.localName)
      entry.localName =
        localName.trim().slice(0, 32) || entry.sourceName || generatedFollowName(shareId)
      entry.saved = true
      try {
        console.info('[constellation-persist] follow-save-queued')
        await persist(true)
      } catch (error) {
        entry.localName = previousName
        entry.usesPrivateName = previousUsesPrivateName
        entry.saved = wasSaved
        throw error
      }
      publish()
    },
    setFollowName: (shareId, name) => {
      const entry = followed.get(shareId)
      if (!entry) return
      entry.usesPrivateName = Boolean(name.trim())
      entry.localName = name.trim().slice(0, 32) || entry.sourceName || generatedFollowName(shareId)
      if (entry.peerId && namePreference(entry.peerId).associateNames) {
        peerNamePreferences.set(entry.peerId, {
          ...namePreference(entry.peerId),
          nickname: name.trim().slice(0, 32),
        })
      }
      if (entry.saved)
        void persist().catch(() => publish({ message: 'Nickname could not be saved.' }))
      publish()
    },
    setFollowColor: (shareId, color) => {
      if (!FOLLOW_COLORS.includes(color as (typeof FOLLOW_COLORS)[number])) return
      const entry = followed.get(shareId)
      if (!entry) return
      for (const candidate of followed.values()) {
        if (candidate.sourcePeerId === entry.sourcePeerId) candidate.color = color
      }
      if (entry.saved) void persist().catch(() => publish({ message: 'Color could not be saved.' }))
      publish()
    },
    setVisible: (nextVisible, acquireLocation = true) => {
      visible = nextVisible
      if (visible) {
        if (acquireLocation || shares.size > 0) locationSource.start()
      } else {
        for (const share of shares.values()) {
          if (share.publication === 'foreground') share.latest = undefined
        }
        if (![...shares.values()].some((share) => share.publication === 'background')) {
          locationSource.stop()
        }
      }
      publish()
    },
    stopShare: async (shareId) => {
      const share = shares.get(shareId)
      if (!share) return
      const oldRecord: OldShareSummary = {
        shareId,
        ...(share.name ? { name: share.name } : {}),
        reason: 'revoked',
        endedAt: Date.now(),
      }
      const previousOldRecords = new Map(oldSharing)
      const wasReturnLinkApproved = approvedReturnLinks.has(shareId)
      const removedOffers = [...returnOffers.entries()].filter(
        ([, offer]) => offer.shareId === shareId,
      )
      const previousEndNotifications = new Map(endedShares)
      pendingRevocations.add(shareId)
      rememberEndNotification(share, 'revoked', oldRecord.endedAt)
      const prunedEndIds = pruneEndNotifications()
      shares.delete(shareId)
      rememberEndedShareHistory(
        {
          shareId,
          name: share.name,
          viewerPeerIds: share.viewerPeerIds,
        },
        'revoked',
        oldRecord.endedAt,
      )
      approvedReturnLinks.delete(shareId)
      removedOffers.forEach(([key]) => returnOffers.delete(key))
      try {
        await persist()
        pendingRevocations.delete(shareId)
      } catch (error) {
        pendingRevocations.delete(shareId)
        shares.set(shareId, share)
        endedShares.clear()
        previousEndNotifications.forEach((record, id) => endedShares.set(id, record))
        oldSharing.clear()
        previousOldRecords.forEach((record, key) => oldSharing.set(key, record))
        if (wasReturnLinkApproved) approvedReturnLinks.add(shareId)
        removedOffers.forEach(([key, offer]) => returnOffers.set(key, offer))
        throw error
      }
      for (const [key, request] of pendingViewerApprovals) {
        if (request.shareId === shareId) pendingViewerApprovals.delete(key)
      }
      for (const session of share.sessions) {
        if (session.sessionId) {
          session.send(
            constellationProtocolV2.streams['share.sessions'].closed.parse({
              type: 'closed',
              sessionId: session.sessionId,
              reason: 'revoked',
            }),
          )
        }
      }
      await Promise.all([...share.sessions].map((session) => session.closeAfterFlush()))
      await Promise.all(prunedEndIds.map(stopSourcePeer))
      if (!shares.size) locationSource.stop()
      publish()
    },
    stopEndNotifications: async () => {
      const previous = new Map(endedShares)
      endedShares.clear()
      try {
        await persist()
      } catch (error) {
        previous.forEach((record, id) => endedShares.set(id, record))
        throw error
      }
      await Promise.all([...previous.keys()].map(stopSourcePeer))
      publish()
    },
    stop: async () => {
      runtimeClosed = true
      for (const run of comparisonRuns.values()) {
        run.cancelled = true
        await run.close?.()
      }
      window.clearInterval(heartbeatSweep)
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
      unsubscribeLocationState()
      unsubscribeLocationObservation()
      locationSource.stop()
      await Promise.all([...viewerClosers.values()].map((close) => close()))
      for (const share of shares.values()) {
        await Promise.all([...share.sessions].map((session) => session.close()))
      }
      await Promise.all(
        [...new Set([...sourceStarts.keys(), ...sourceNodes.keys()])].map((shareId) =>
          stopSourcePeer(shareId),
        ),
      )
      if (handlerNode) {
        await handlerNode.unhandle(SHARE_STREAM_PROTOCOL)
        await handlerNode.stop()
      }
      shares.clear()
      received.clear()
      followed.clear()
      observers.clear()
    },
  }
  return runtime
}
