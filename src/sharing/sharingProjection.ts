import { privateKeyToProtobuf } from '@libp2p/crypto/keys'
import type { PrivateKey } from '@libp2p/interface'
import type { LocationObservationV1 } from '../location/locationObservation.ts'
import type { ComparisonBudget, DeviceComparison } from './deviceComparison.ts'
import { bytesToBase64Url } from './encoding.ts'
import type { PeerNamePreference } from './peerNames.ts'
import { displayedPeerName } from './peerNames.ts'
import type { PendingStopNotice, PrivateState, StoppedViewerRecord } from './privateStore.ts'
import { END_NOTICE_RETENTION_MS } from './shareLifecycle.ts'
import type { NetworkRestriction } from './sharePolicy.ts'
import { backgroundSharePolicy, sharePauseState } from './sharePolicy.ts'
import type {
  EndedSourceShare,
  FollowEntry,
  FollowStatus,
  FollowSummary,
  OldShareSummary,
  PendingViewerApproval,
  ReturnOffer,
  ShareSummary,
  SharingRuntimeState,
  SourceShare,
} from './sharingContracts.ts'
import { pruneFollowTrace, type FollowTraceEvent } from './followTrace.ts'
import type { SharingBehavior } from './sharingBehavior.ts'

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

type SavedFollowEntry = {
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
  traceEnabled?: boolean
  trace?: readonly FollowTraceEvent[]
}

const savedFollowRecord = (entry: SavedFollowEntry): PrivateState['followed'][number] => ({
  url: entry.url,
  localName: entry.localName,
  ...(entry.sourceName ? { sourceName: entry.sourceName } : {}),
  ...(entry.usesPrivateName !== undefined ? { usesPrivateName: entry.usesPrivateName } : {}),
  color: entry.color,
  ...(entry.followedAt ? { followedAt: entry.followedAt } : {}),
  ...(entry.returnPromptSeen ? { returnPromptSeen: true } : {}),
  ...(entry.approvalDenied ? { approvalDenied: true } : {}),
  ...(entry.terminal === 'expired' || entry.terminal === 'revoked'
    ? { endReason: entry.terminal }
    : {}),
  ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
  ...(entry.traceEnabled ? { traceEnabled: true, trace: pruneFollowTrace(entry.trace ?? []) } : {}),
})

export const savedFollowRecords = (
  entries: readonly SavedFollowEntry[],
): PrivateState['followed'] => entries.filter((entry) => entry.saved).map(savedFollowRecord)

export interface RuntimeProjectionInput {
  readonly state: SharingRuntimeState
  readonly patch: Partial<SharingRuntimeState>
  readonly now: number
  readonly sharingBehavior: SharingBehavior | undefined
  readonly paused: boolean
  readonly peerNamePreferences: ReadonlyMap<string, PeerNamePreference>
  readonly shares: ReadonlyMap<string, SourceShare>
  readonly received: ReadonlyMap<string, LocationObservationV1>
  readonly followed: ReadonlyMap<string, FollowEntry>
  readonly endedShares: ReadonlyMap<string, EndedSourceShare>
  readonly returnOffers: ReadonlyMap<string, ReturnOffer>
  readonly approvedReturnLinks: ReadonlySet<string>
  readonly pendingViewerApprovals: ReadonlyMap<string, PendingViewerApproval>
  readonly deviceComparisons: readonly DeviceComparison[]
  readonly oldSharing: ReadonlyMap<string, OldShareSummary>
  readonly oldSeeing: ReadonlyMap<string, OldShareSummary>
  readonly stoppedViewers: ReadonlyMap<string, StoppedViewerRecord>
  readonly viewerLabels: ReadonlyMap<string, string>
  readonly networkRestriction: NetworkRestriction | undefined
}

const projectShareViewers = (
  share: SourceShare,
  peerNamePreferences: ReadonlyMap<string, PeerNamePreference>,
  viewerLabels: ReadonlyMap<string, string>,
): ShareSummary['viewers'] =>
  [...share.sessions]
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
    })

const projectShare = (share: SourceShare, input: RuntimeProjectionInput): ShareSummary => {
  const paused = sharePauseState(share, input.networkRestriction, input.paused)
  return {
    shareId: share.capability.shareId,
    url: share.url,
    precision: share.precision,
    expiresAt: share.capability.expiresAt,
    recipientPeerId: share.approvedPeerId,
    viewerCount: share.sessions.size,
    viewers: projectShareViewers(share, input.peerNamePreferences, input.viewerLabels),
    ...(share.name ? { name: share.name } : {}),
    publication: share.publication,
    battery: share.battery,
    network: share.network,
    ...(paused ? { paused } : {}),
    ...(share.latest ? { lastUpdateAt: share.latest.capturedAt } : {}),
  }
}

const projectShares = (input: RuntimeProjectionInput): ShareSummary[] =>
  [...input.shares.values()].map((share) => projectShare(share, input))

const projectReceived = (input: RuntimeProjectionInput): SharingRuntimeState['received'] =>
  [...input.received.entries()].map(([shareId, observation]) => ({
    shareId,
    observation,
    state:
      !input.followed.get(shareId)?.connected || input.now >= observation.expiresAt
        ? 'stale'
        : input.now >= observation.capturedAt + 15_000
          ? 'delayed'
          : 'live',
  }))

const terminalFor = (
  entry: FollowEntry,
  now: number,
): 'expired' | 'revoked' | 'unavailable' | undefined =>
  entry.terminal ?? (entry.expiresAt !== null && now >= entry.expiresAt ? 'expired' : undefined)

const projectFollow = (
  shareId: string,
  entry: FollowEntry,
  input: RuntimeProjectionInput,
): FollowSummary => {
  const observation = input.received.get(shareId)
  const displayName = displayedPeerName(
    entry.peerId ? input.peerNamePreferences.get(entry.peerId) : undefined,
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
      terminal: terminalFor(entry, input.now),
      now: input.now,
    }),
    saved: entry.saved,
    ...(entry.followedAt ? { followedAt: entry.followedAt } : {}),
    ...(observation ? { lastLocationAt: observation.capturedAt } : {}),
    updatesReceived: entry.updatesReceived,
    traceEnabled: entry.traceEnabled === true,
    ...(entry.traceEnabled ? { trace: pruneFollowTrace(entry.trace ?? [], input.now) } : {}),
    expiresAt: entry.expiresAt,
    returnPromptSeen: entry.returnPromptSeen,
    ...(entry.approvalPending ? { approvalPending: true } : {}),
    ...(entry.approvalDenied ? { approvalDenied: true } : {}),
    ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
  }
}

const projectFollowing = (input: RuntimeProjectionInput): FollowSummary[] =>
  [...input.followed.entries()].map(([shareId, entry]) => projectFollow(shareId, entry, input))

const projectEndNotifications = (
  input: RuntimeProjectionInput,
): SharingRuntimeState['endNotifications'] =>
  [...input.endedShares.values()].map((share) => ({
    shareId: share.capability.shareId,
    publication: share.publication,
    retainUntil: share.endedAt + END_NOTICE_RETENTION_MS,
  }))

const projectHistory = (records: ReadonlyMap<string, OldShareSummary>): OldShareSummary[] =>
  [...records.values()]
    .filter((record) => !record.cleared)
    .sort((left, right) => right.endedAt - left.endedAt)

const projectStoppedViewers = (
  records: ReadonlyMap<string, StoppedViewerRecord>,
): StoppedViewerRecord[] =>
  [...records.values()]
    .filter((record) => !record.cleared)
    .sort((left, right) => right.recordedAt - left.recordedAt)

export const projectRuntimeState = (input: RuntimeProjectionInput): SharingRuntimeState => ({
  ...input.state,
  ...input.patch,
  sharingBehavior: input.sharingBehavior,
  paused: input.paused,
  peerNamePreferences: [...input.peerNamePreferences.values()],
  shares: projectShares(input),
  received: projectReceived(input),
  following: projectFollowing(input),
  endNotifications: projectEndNotifications(input),
  returnOffers: [...input.returnOffers.values()],
  approvedReturnLinks: [...input.approvedReturnLinks],
  pendingViewerApprovals: [...input.pendingViewerApprovals.values()],
  deviceComparisons: input.deviceComparisons,
  oldSharing: projectHistory(input.oldSharing),
  oldSeeing: projectHistory(input.oldSeeing),
  stoppedViewers: projectStoppedViewers(input.stoppedViewers),
})

export interface SnapshotProjectionInput {
  readonly privateKey: PrivateKey
  readonly pendingSharingBehavior: SharingBehavior | undefined
  readonly sharingBehavior: SharingBehavior | undefined
  readonly paused: boolean
  readonly deviceComparisons: DeviceComparison[]
  readonly comparisonBudgets: ComparisonBudget[]
  readonly shares: ReadonlyMap<string, SourceShare>
  readonly endedShares: ReadonlyMap<string, EndedSourceShare>
  readonly peerNamePreferences: ReadonlyMap<string, PeerNamePreference>
  readonly followed: ReadonlyMap<string, FollowEntry>
  readonly approvedReturnLinks: ReadonlySet<string>
  readonly pendingReturns: ReadonlyMap<string, string>
  readonly returnOffers: ReadonlyMap<string, ReturnOffer>
  readonly oldSharing: ReadonlyMap<string, OldShareSummary>
  readonly stoppedViewers: ReadonlyMap<string, StoppedViewerRecord>
  readonly pendingStopNotices: ReadonlyMap<string, PendingStopNotice>
  readonly oldSeeing: ReadonlyMap<string, OldShareSummary>
  readonly viewerLabels: ReadonlyMap<string, string>
}

const privateKeyString = (privateKey: PrivateKey): string =>
  bytesToBase64Url(privateKeyToProtobuf(privateKey))

const snapshotSharePolicy = (
  share: SourceShare,
  pendingSharingBehavior: SharingBehavior | undefined,
): Pick<SourceShare, 'publication' | 'battery' | 'network'> =>
  pendingSharingBehavior
    ? {
        publication: pendingSharingBehavior.publication,
        ...backgroundSharePolicy(
          pendingSharingBehavior.publication,
          pendingSharingBehavior.battery,
          pendingSharingBehavior.network,
        ),
      }
    : { publication: share.publication, battery: share.battery, network: share.network }

const snapshotShare = (
  share: SourceShare,
  pendingSharingBehavior: SharingBehavior | undefined,
): PrivateState['shares'][number] => ({
  url: share.url,
  ...(share.sourcePrivateKey ? { sourcePrivateKey: privateKeyString(share.sourcePrivateKey) } : {}),
  precision: share.precision,
  capacity: share.capacity,
  ...(share.requireViewerApproval === false ? { requireViewerApproval: false } : {}),
  ...(share.approvedPeerId ? { approvedPeerId: share.approvedPeerId } : {}),
  ...(share.viewerPeerIds.size ? { viewerPeerIds: [...share.viewerPeerIds] } : {}),
  name: share.name,
  ...snapshotSharePolicy(share, pendingSharingBehavior),
  blockedPeerIds: [...share.blockedPeerIds],
  approximation: share.approximation,
})

const snapshotShares = (input: SnapshotProjectionInput): PrivateState['shares'] =>
  [...input.shares.values()].map((share) => snapshotShare(share, input.pendingSharingBehavior))

const snapshotEndedShares = (
  input: SnapshotProjectionInput,
): NonNullable<PrivateState['endedShares']> =>
  [...input.endedShares.values()].map((share) => ({
    url: share.url,
    ...(share.sourcePrivateKey
      ? { sourcePrivateKey: privateKeyString(share.sourcePrivateKey) }
      : {}),
    ...(share.capacity ? { capacity: share.capacity } : {}),
    ...(share.approvedPeerId ? { approvedPeerId: share.approvedPeerId } : {}),
    publication: share.publication,
    reason: share.reason,
    endedAt: share.endedAt,
  }))

const snapshotViewerLabels = (
  viewerLabels: ReadonlyMap<string, string>,
): PrivateState['viewerLabels'] =>
  [...viewerLabels].map(([key, name]) => {
    const separator = key.indexOf(':')
    return { shareId: key.slice(0, separator), fingerprint: key.slice(separator + 1), name }
  })

export const snapshotPrivateState = (input: SnapshotProjectionInput): PrivateState => {
  const behavior = input.pendingSharingBehavior ?? input.sharingBehavior
  return {
    ...(behavior ? { sharingBehavior: behavior } : {}),
    ...(input.paused ? { paused: true } : {}),
    version: 1,
    deviceComparisons: input.deviceComparisons,
    comparisonBudgets: input.comparisonBudgets,
    privateKey: privateKeyString(input.privateKey),
    shares: snapshotShares(input),
    endedShares: snapshotEndedShares(input),
    peerNamePreferences: [...input.peerNamePreferences.values()],
    followed: savedFollowRecords([...input.followed.values()]),
    approvedReturnLinks: [...input.approvedReturnLinks],
    pendingReturns: [...input.pendingReturns].map(([shareId, url]) => ({ shareId, url })),
    returnOffers: [...input.returnOffers.values()],
    oldSharing: [...input.oldSharing.values()],
    stoppedViewers: [...input.stoppedViewers.values()],
    pendingStopNotices: [...input.pendingStopNotices.values()],
    oldSeeing: [...input.oldSeeing.values()],
    viewerLabels: snapshotViewerLabels(input.viewerLabels),
  }
}
