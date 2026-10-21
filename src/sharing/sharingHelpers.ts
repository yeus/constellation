import type {
  FollowEntry,
  OldShareSummary,
  SessionEvent,
  SharingRuntime,
  SharingRuntimeState,
  SourceSession,
  SourceShare,
} from './sharingContracts.ts'
import { projectRuntimeState, snapshotPrivateState } from './sharingProjection.ts'
import { restoredEndedSourceShare, restoredSourceShare } from './sharingRestore.ts'
import { acceptReturnShare } from './sharingReturn.ts'
import { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
import { pruneFollowTrace } from './followTrace.ts'

import { hasEndedPeerShare } from './peerHistory.ts'
import {
  DEVICE_COMPARISON_PROTOCOL,
  COMPARISON_TTL_MS,
  deviceComparisonProtocol,
  createComparisonResponder,
  reserveComparisonAttempt,
  type DeviceComparison,
} from './deviceComparison.ts'
import { createPortClient, createPortServer } from '@taskyon/protocol'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import { generateKeyPair, privateKeyFromProtobuf } from '@libp2p/crypto/keys'

import { projectApproximateLocation, type ApproximationState } from '../location/approximation.ts'
import type { BrowserLocationSource } from '../location/browser.ts'
import { type LocationObservationV1 } from '../location/locationObservation.ts'
import { disclosedPrecisionFor, VERY_COARSE_RADIUS_METERS } from '../shareDraft.ts'
import {
  createProtocolMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
} from './browserPeer.ts'
import { base64UrlToBytes } from './encoding.ts'
import type { PeerNamePreference } from './peerNames.ts'
import { receiveAdvertisedName, peerNamesProtocol, PEER_NAMES_PROTOCOL } from './peerNames.ts'
import { verifyRedemptionProof, verifyStopNoticeProof } from './shareAuth.ts'
import { parseShareInvitation, verifyReturnOwner } from './shareLink.ts'
import { sharePauseReason } from './sharePolicy.ts'
import { encryptLocationPayload } from './sharePayloadCrypto.ts'
import { rotatePendingNotice } from './stopNotice.ts'
import {
  constellationProtocolV2,
  SHARE_STREAM_PROTOCOL,
  parseConstellationMessage,
  type ConstellationMessage,
} from './shareProtocol.ts'
import {
  type PrivateState,
  type PrivateStateStore,
  type PendingStopNotice,
} from './privateStore.ts'
import { END_NOTICE_RETENTION_MS, retainedEndNotifications } from './shareLifecycle.ts'
import { recordStoppedViewer, STOP_NOTICE_RETENTION_MS } from './stopNotice.ts'

import type { SharingState } from './sharingState.ts'
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_PENDING_VIEWER_APPROVALS_PER_SHARE,
  MAX_REMEMBERED_VIEWER_PEERS,
  LOCATION_SENSOR_ID,
  DESCRIPTOR_REVISION,
  appendSessionEvent,
  claimSingleRecipient,
  randomToken,
  rememberRedeemedNonce,
  requireAuthorized,
  sessionSweepReason,
  viewerFingerprint,
} from './sharingRuntimeHelpers.ts'

export interface SharingContext extends SharingState {
  readonly locationSource: BrowserLocationSource
  readonly shareBaseUrl: string
  readonly store: PrivateStateStore | undefined
  readonly returnShareReceiver: 'local' | 'external'
  runtimeApi?: Pick<SharingRuntime, 'acceptShare'>
  heartbeatSweep: number
  unsubscribeLocationState: () => void
  unsubscribeLocationObservation: () => void
  namePreference: ReturnType<typeof namePreference>
  receivePeerName: ReturnType<typeof receivePeerName>
  viewerApprovalKey: typeof viewerApprovalKey
  insertImportedEntries: typeof insertImportedEntries
  applyHistoryRecords: typeof applyHistoryRecords
  stoppedViewerKey: typeof stoppedViewerKey
  rememberLifecycleRecord: typeof rememberLifecycleRecord
  rememberEndedShareHistory: ReturnType<typeof rememberEndedShareHistory>
  rememberViewerPeer: typeof rememberViewerPeer
  publish: ReturnType<typeof publish>
  snapshot: ReturnType<typeof snapshot>
  persist: ReturnType<typeof persist>
  useEphemeralIdentity: ReturnType<typeof useEphemeralIdentity>
  prepareState: ReturnType<typeof prepareState>
  recordSessionEvent: ReturnType<typeof recordSessionEvent>
  removeSession: ReturnType<typeof removeSession>
  encryptedObservationMessage: ReturnType<typeof encryptedObservationMessage>
  comparisonPeerIsEligible: ReturnType<typeof comparisonPeerIsEligible>
  comparisonIsCurrent: ReturnType<typeof comparisonIsCurrent>
  reserveDeviceComparison: ReturnType<typeof reserveDeviceComparison>
  handleComparisonStream: ReturnType<typeof handleComparisonStream>
  handleIncomingStream: ReturnType<typeof handleIncomingStream>
  handleNameStream: ReturnType<typeof handleNameStream>
  startPeer: ReturnType<typeof startPeer>
  startSourcePeer: ReturnType<typeof startSourcePeer>
  stopSourcePeer: ReturnType<typeof stopSourcePeer>
  pruneEndNotifications: ReturnType<typeof pruneEndNotifications>
  rememberEndNotification: ReturnType<typeof rememberEndNotification>
  endFollowing: ReturnType<typeof endFollowing>
  acceptPendingReturn: ReturnType<typeof acceptPendingReturn>
  ensurePeer: ReturnType<typeof ensurePeer>
  updateShareLocation: ReturnType<typeof updateShareLocation>
  retryPendingStopNotices: ReturnType<typeof retryPendingStopNotices>
}

export const namePreference =
  (ctx: SharingContext) =>
  (peerId: string): PeerNamePreference =>
    ctx.peerNamePreferences.get(peerId) ?? {
      peerId,
      associateNames: false,
      sharedName: null,
      receivedName: null,
    }

export const receivePeerName =
  (ctx: SharingContext) =>
  async (peerId: string, receivedName: string | null): Promise<void> => {
    if (ctx.peerNamePreferences.size >= 1_024 && !ctx.peerNamePreferences.has(peerId)) return
    const previous = ctx.namePreference(peerId)
    const currentFollow = [...ctx.followed.values()].find((entry) => entry.peerId === peerId)
    const currentName =
      currentFollow?.sourceName ||
      (currentFollow?.usesPrivateName ? currentFollow.localName : undefined)
    const next = receiveAdvertisedName(previous, receivedName, currentName)
    const previousEntries = [...ctx.followed.values()]
      .filter((entry) => entry.peerId === peerId)
      .map((entry) => ({ entry, localName: entry.localName, sourceName: entry.sourceName }))
    ctx.peerNamePreferences.set(peerId, next)
    for (const { entry } of previousEntries) {
      if (!entry.usesPrivateName && !entry.sourceName && !previous.acceptedName && receivedName)
        entry.localName = receivedName
      entry.sourceName = receivedName ?? entry.linkSourceName
    }
    try {
      await ctx.persist()
    } catch {
      ctx.peerNamePreferences.set(peerId, previous)
      for (const { entry, localName, sourceName } of previousEntries) {
        entry.localName = localName
        entry.sourceName = sourceName
      }
      ctx.publish({ message: 'Received name could not be saved.' })
      return
    }
    ctx.publish()
  }

export const viewerApprovalKey = (shareId: string, peerId: string): string =>
  JSON.stringify([shareId, peerId])

export const insertImportedEntries = <T>(
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

export const applyHistoryRecords = <T>(
  target: Map<string, T>,
  records: ReadonlyMap<string, T>,
): void => {
  target.clear()
  for (const [key, record] of records) target.set(key, record)
}

export const stoppedViewerKey = (shareId: string, peerId: string): string =>
  JSON.stringify([shareId, peerId])

export const rememberLifecycleRecord = (
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

export const rememberEndedShareHistory =
  (ctx: SharingContext) =>
  (
    share: { shareId: string; name?: string; viewerPeerIds: Iterable<string> },
    reason: OldShareSummary['reason'],
    endedAt: number,
  ): void => {
    const peerIds = [...share.viewerPeerIds].slice(0, MAX_REMEMBERED_VIEWER_PEERS)
    for (const peerId of peerIds.length ? peerIds : [undefined]) {
      ctx.rememberLifecycleRecord(ctx.oldSharing, {
        shareId: share.shareId,
        ...(peerId ? { peerId } : {}),
        ...(share.name ? { name: share.name } : {}),
        reason,
        endedAt,
      })
    }
  }

export const rememberViewerPeer = (share: SourceShare, peerId: string): boolean => {
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

export const publish =
  (ctx: SharingContext) =>
  (patch: Partial<SharingRuntimeState> = {}): void => {
    if (Object.hasOwn(patch, 'message')) {
      if (ctx.noticeTimer !== undefined) window.clearTimeout(ctx.noticeTimer)
      ctx.noticeTimer = undefined
      if (patch.message) {
        ctx.noticeTimer = window.setTimeout(() => {
          ctx.noticeTimer = undefined
          ctx.publish({ message: '' })
        }, 6_000)
      }
    }
    ctx.state = projectRuntimeState({
      state: ctx.state,
      patch,
      now: Date.now(),
      sharingBehavior: ctx.sharingBehavior,
      paused: ctx.paused,
      peerNamePreferences: ctx.peerNamePreferences,
      shares: ctx.shares,
      received: ctx.received,
      followed: ctx.followed,
      endedShares: ctx.endedShares,
      returnOffers: ctx.returnOffers,
      approvedReturnLinks: ctx.approvedReturnLinks,
      pendingViewerApprovals: ctx.pendingViewerApprovals,
      deviceComparisons: [...ctx.deviceComparisons.values()].filter(ctx.comparisonIsCurrent),
      oldSharing: ctx.oldSharing,
      oldSeeing: ctx.oldSeeing,
      stoppedViewers: ctx.stoppedViewers,
      viewerLabels: ctx.viewerLabels,
      networkRestriction: ctx.networkRestriction,
    })
    ctx.observers.forEach((observer) => observer(ctx.state))
  }

export const snapshot = (ctx: SharingContext) => (): PrivateState => {
  if (!ctx.privateKey) throw new Error('Protected peer identity is unavailable.')
  return snapshotPrivateState({
    privateKey: ctx.privateKey,
    pendingSharingBehavior: ctx.pendingSharingBehavior,
    sharingBehavior: ctx.sharingBehavior,
    paused: ctx.paused,
    deviceComparisons: [...ctx.deviceComparisons.values()].filter(
      (entry) => entry.confirmedAt !== undefined && ctx.comparisonIsCurrent(entry),
    ),
    comparisonBudgets: ctx.comparisonBudgets,
    shares: ctx.shares,
    endedShares: ctx.endedShares,
    peerNamePreferences: ctx.peerNamePreferences,
    followed: ctx.followed,
    approvedReturnLinks: ctx.approvedReturnLinks,
    pendingReturns: ctx.pendingReturns,
    returnOffers: ctx.returnOffers,
    oldSharing: ctx.oldSharing,
    stoppedViewers: ctx.stoppedViewers,
    pendingStopNotices: ctx.pendingStopNotices,
    oldSeeing: ctx.oldSeeing,
    viewerLabels: ctx.viewerLabels,
  })
}

export const persist =
  (ctx: SharingContext) =>
  (traceFollow = false): Promise<void> => {
    if (!ctx.store) return Promise.resolve()
    const store = ctx.store
    if (!ctx.privateStateAvailable) {
      return Promise.reject(
        new Error('Protected storage is unavailable; this location can only be previewed.'),
      )
    }
    const saved = ctx.snapshot()
    ctx.persistence = ctx.persistence
      .catch(() => undefined)
      .then(async () => {
        if (traceFollow) console.info('[constellation-persist] native-save-start')
        await store.save(saved)
        if (traceFollow) console.info('[constellation-persist] native-save-complete')
      })
    return ctx.persistence
  }

export const useEphemeralIdentity = (ctx: SharingContext) => async (): Promise<void> => {
  ctx.privateStateAvailable = false
  ctx.privateKey ??= await generateKeyPair('Ed25519')
  ctx.publish({ canSave: false, message: 'Protected storage is unavailable; preview only.' })
}

const loadPrivateState = async (
  ctx: SharingContext,
  store: NonNullable<SharingContext['store']>,
) => {
  try {
    return await store.load()
  } catch {
    await ctx.useEphemeralIdentity()
    return null
  }
}

const initializePrivateKey = async (ctx: SharingContext, saved: PrivateState | undefined) => {
  ctx.privateKey = saved
    ? privateKeyFromProtobuf(base64UrlToBytes(saved.privateKey))
    : await generateKeyPair('Ed25519')
  if (saved) return true
  try {
    await ctx.persist()
    return true
  } catch {
    await ctx.useEphemeralIdentity()
    return false
  }
}

const restoreDeviceState = (ctx: SharingContext, saved: PrivateState | undefined) => {
  ctx.sharingBehavior = saved?.sharingBehavior
  ctx.comparisonBudgets.push(...(saved?.comparisonBudgets ?? []))
  for (const entry of saved?.deviceComparisons ?? []) {
    ctx.deviceComparisons.set(entry.challenge, entry)
  }
}

const restoreExpiredSourceShare = (ctx: SharingContext, record: PrivateState['shares'][number]) => {
  try {
    const expired = parseShareInvitation(record.url, 0)
    if (expired.expiresAt === null || expired.expiresAt > Date.now()) return true
    ctx.endedShares.set(expired.shareId, {
      capacity: record.capacity,
      approvedPeerId: record.approvedPeerId,
      capability: expired,
      url: record.url,
      publication: record.publication,
      reason: 'expired',
      endedAt: expired.expiresAt,
      ...(record.sourcePrivateKey
        ? { sourcePrivateKey: privateKeyFromProtobuf(base64UrlToBytes(record.sourcePrivateKey)) }
        : {}),
    })
    ctx.rememberEndedShareHistory(
      { shareId: expired.shareId, name: record.name, viewerPeerIds: record.viewerPeerIds ?? [] },
      'expired',
      expired.expiresAt,
    )
  } catch {
    // Invalid links remain discarded without retaining their contents.
  }
  return true
}

const restoreSourceShares = (ctx: SharingContext, saved: PrivateState | undefined) => {
  let changed = false
  for (const record of saved?.shares ?? []) {
    try {
      const capability = parseShareInvitation(record.url)
      ctx.shares.set(capability.shareId, restoredSourceShare(record, ctx.sharingBehavior))
    } catch {
      changed = restoreExpiredSourceShare(ctx, record) || changed
    }
  }
  return changed
}

const restoreEndedShares = (ctx: SharingContext, saved: PrivateState | undefined) => {
  const retained = retainedEndNotifications(saved?.endedShares ?? [])
  ctx.paused = (saved?.paused ?? false) && ctx.shares.size > 0
  let changed = retained.length !== (saved?.endedShares?.length ?? 0)
  for (const record of retained) {
    try {
      const capability = parseShareInvitation(record.url, 0)
      if (ctx.shares.has(capability.shareId)) {
        changed = true
        continue
      }
      ctx.endedShares.set(capability.shareId, restoredEndedSourceShare(record))
    } catch {
      changed = true
    }
  }
  return changed
}

const restoreFollow = async (ctx: SharingContext, record: PrivateState['followed'][number]) => {
  const capability = parseShareInvitation(record.url)
  const knownPeerId =
    capability.ownerPeerId && (await verifyReturnOwner(capability))
      ? capability.ownerPeerId
      : undefined
  ctx.followed.set(capability.shareId, {
    url: record.url,
    sourcePeerId: capability.sourcePeerId,
    peerId: knownPeerId,
    localName: record.localName,
    sourceName: record.sourceName,
    usesPrivateName:
      record.usesPrivateName ?? record.localName !== generatedFollowName(capability.shareId),
    color: record.color,
    connected: false,
    saved: true,
    followedAt: record.followedAt,
    traceEnabled: record.traceEnabled === true,
    ...(record.traceEnabled ? { trace: pruneFollowTrace(record.trace ?? []) } : {}),
    returnPromptSeen: record.returnPromptSeen ?? false,
    approvalDenied: record.approvalDenied ?? false,
    ...(record.endReason ? { terminal: record.endReason } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    updatesReceived: 0,
    expiresAt: capability.expiresAt,
  })
}

const restoreExpiredFollow = (ctx: SharingContext, record: PrivateState['followed'][number]) => {
  try {
    const expired = parseShareInvitation(record.url, 0)
    if (expired.expiresAt === null || expired.expiresAt > Date.now()) return false
    const endedAt = expired.expiresAt
    ctx.followed.set(expired.shareId, {
      url: record.url,
      sourcePeerId: expired.sourcePeerId,
      localName: record.localName,
      color: record.color,
      connected: false,
      saved: true,
      returnPromptSeen: record.returnPromptSeen ?? true,
      traceEnabled: record.traceEnabled === true,
      ...(record.traceEnabled ? { trace: pruneFollowTrace(record.trace ?? []) } : {}),
      terminal: 'expired',
      endedAt,
      updatesReceived: 0,
      expiresAt: expired.expiresAt,
    })
    ctx.rememberLifecycleRecord(ctx.oldSeeing, {
      ...(expired.ownerPeerId ? { peerId: expired.ownerPeerId } : {}),
      shareId: expired.shareId,
      name: record.localName,
      reason: 'expired',
      endedAt,
    })
  } catch {
    // Invalid links are not restored.
  }
  return true
}

const restoreFollows = async (ctx: SharingContext, saved: PrivateState | undefined) => {
  let changed = false
  for (const record of saved?.followed ?? []) {
    try {
      await restoreFollow(ctx, record)
    } catch {
      changed = restoreExpiredFollow(ctx, record) || changed
    }
  }
  return changed
}

const restoreRelations = (ctx: SharingContext, saved: PrivateState | undefined) => {
  for (const preference of saved?.peerNamePreferences ?? []) {
    ctx.peerNamePreferences.set(preference.peerId, preference)
  }
  for (const record of saved?.viewerLabels ?? []) {
    ctx.viewerLabels.set(`${record.shareId}:${record.fingerprint}`, record.name)
  }
  for (const shareId of saved?.approvedReturnLinks ?? []) ctx.approvedReturnLinks.add(shareId)
  for (const { shareId, url } of saved?.pendingReturns ?? []) ctx.pendingReturns.set(shareId, url)
  for (const offer of saved?.returnOffers ?? []) {
    ctx.returnOffers.set(`${offer.shareId}:${offer.viewerFingerprint}`, offer)
  }
  for (const record of saved?.oldSharing ?? []) {
    ctx.rememberLifecycleRecord(ctx.oldSharing, record)
  }
  for (const record of saved?.oldSeeing ?? []) {
    ctx.rememberLifecycleRecord(ctx.oldSeeing, record)
  }
  for (const record of saved?.stoppedViewers ?? []) {
    ctx.stoppedViewers.set(ctx.stoppedViewerKey(record.shareId, record.peerId), record)
  }
  let changed = false
  for (const pending of saved?.pendingStopNotices ?? []) {
    if (Date.now() - pending.queuedAt < STOP_NOTICE_RETENTION_MS) {
      ctx.pendingStopNotices.set(pending.eventId, pending)
    } else changed = true
  }
  return changed
}

const pruneRestoredRelations = (ctx: SharingContext) => {
  let changed = false
  for (const shareId of ctx.approvedReturnLinks) {
    if (ctx.shares.has(shareId)) continue
    ctx.approvedReturnLinks.delete(shareId)
    changed = true
  }
  for (const [key, offer] of ctx.returnOffers) {
    if (ctx.shares.has(offer.shareId)) continue
    ctx.returnOffers.delete(key)
    changed = true
  }
  changed = ctx.pruneEndNotifications().length > 0 || changed
  return changed
}

const applyInitialLocation = (ctx: SharingContext) => {
  const currentLocation = ctx.locationSource.getState()
  if (
    (currentLocation.status !== 'live' && currentLocation.status !== 'delayed') ||
    currentLocation.observation.expiresAt <= Date.now()
  )
    return
  let changed = false
  for (const share of ctx.shares.values()) {
    if (ctx.updateShareLocation(share, currentLocation.observation)) changed = true
  }
  if (changed) {
    void ctx
      .persist()
      .catch(() => ctx.publish({ message: 'Private share state could not be saved.' }))
  }
}

const prepareFromStore = async (
  ctx: SharingContext,
  store: NonNullable<SharingContext['store']>,
) => {
  const saved = await loadPrivateState(ctx, store)
  if (saved === null || !(await initializePrivateKey(ctx, saved))) return
  restoreDeviceState(ctx, saved)
  let changed = restoreSourceShares(ctx, saved)
  changed = restoreEndedShares(ctx, saved) || changed
  changed = (await restoreFollows(ctx, saved)) || changed
  changed = restoreRelations(ctx, saved) || changed
  changed = pruneRestoredRelations(ctx) || changed
  if (saved && changed) await ctx.persist()
  applyInitialLocation(ctx)
  ctx.publish()
}

export const prepareState = (ctx: SharingContext) => (): Promise<void> => {
  if (!ctx.store) return Promise.resolve()
  const store = ctx.store
  if (!ctx.preparation) {
    ctx.preparation = prepareFromStore(ctx, store).catch((error) => {
      ctx.preparation = undefined
      ctx.publish({
        peerStatus: 'error',
        message: error instanceof Error ? error.message : 'Protected shares could not be opened.',
      })
      throw error
    })
  }
  return ctx.preparation
}

export const recordSessionEvent =
  (ctx: SharingContext) =>
  (event: SessionEvent['event']): void => {
    ctx.sessionEvents = appendSessionEvent(ctx.sessionEvents, {
      sequence: ++ctx.sessionEventSequence,
      at: Date.now(),
      event,
      activeSessions: [...ctx.shares.values()].reduce(
        (count, share) => count + share.sessions.size,
        0,
      ),
    })
  }

export const removeSession =
  (ctx: SharingContext) =>
  (session: SourceSession, reason: SessionEvent['event']): void => {
    let removed = false
    for (const share of ctx.shares.values()) {
      if (share.sessions.delete(session)) removed = true
    }
    if (removed) ctx.recordSessionEvent(reason)
    ctx.publish()
  }

export const encryptedObservationMessage =
  (ctx: SharingContext) =>
  async (share: SourceShare, subscriptionId: string): Promise<ConstellationMessage | undefined> => {
    if (ctx.paused || sharePauseReason(share, ctx.networkRestriction)) return undefined
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

export const comparisonPeerIsEligible =
  (ctx: SharingContext) =>
  (entry: Pick<DeviceComparison, 'shareId' | 'peerId' | 'ownPeerId' | 'role'>): boolean => {
    const share = ctx.shares.get(entry.shareId)
    if (entry.role === 'sender') {
      return Boolean(
        share &&
          share.capability.sourcePeerId === entry.ownPeerId &&
          !share.blockedPeerIds.has(entry.peerId) &&
          !ctx.pendingRevocations.has(entry.shareId) &&
          (share.capability.expiresAt === null || Date.now() < share.capability.expiresAt) &&
          (share.approvedPeerId
            ? share.approvedPeerId === entry.peerId
            : ctx.pendingViewerApprovals.has(ctx.viewerApprovalKey(entry.shareId, entry.peerId))),
      )
    }
    const follow = ctx.followed.get(entry.shareId)
    return Boolean(
      follow &&
        follow.sourcePeerId === entry.peerId &&
        (!ctx.handlerNode || ctx.handlerNode.peerId.toString() === entry.ownPeerId) &&
        !follow.terminal &&
        (follow.expiresAt === null || Date.now() < follow.expiresAt) &&
        !follow.approvalDenied,
    )
  }

export const comparisonIsCurrent =
  (ctx: SharingContext) =>
  (entry: DeviceComparison): boolean =>
    (entry.confirmedAt !== undefined || Date.now() < entry.expiresAt) &&
    ctx.comparisonPeerIsEligible(entry)

export const reserveDeviceComparison =
  (ctx: SharingContext) =>
  (shareId: string, ownPeerId: string): Promise<void> =>
    reserveComparisonAttempt(ctx.comparisonBudgets, shareId, ownPeerId, async () => {
      for (const [key, entry] of ctx.deviceComparisons)
        if (entry.shareId === shareId) ctx.deviceComparisons.delete(key)
      ctx.publish()
      await ctx.persist()
    })

type ComparisonConnection = { remotePeer: { toString: () => string } }

const authorizeComparison = (
  ctx: SharingContext,
  connection: ComparisonConnection,
  expectedShareId: string | undefined,
  shareId: string,
) => {
  const share = ctx.shares.get(shareId)
  const peerId = connection.remotePeer.toString()
  if (
    !ctx.store ||
    !ctx.privateStateAvailable ||
    !share ||
    share.capacity !== 1 ||
    (expectedShareId === undefined
      ? share.sourcePrivateKey !== undefined
      : expectedShareId !== shareId) ||
    !ctx.comparisonPeerIsEligible({
      shareId,
      peerId,
      ownPeerId: share.capability.sourcePeerId,
      role: 'sender',
    })
  ) {
    throw new Error('Device comparison denied.')
  }
  return Promise.resolve({
    secret: share.secret,
    binding: { shareId, sourcePeerId: share.capability.sourcePeerId, viewerPeerId: peerId },
  })
}

const completeComparison = (
  ctx: SharingContext,
  binding: { shareId: string; sourcePeerId: string; viewerPeerId: string },
  result: Omit<DeviceComparison, 'shareId' | 'ownPeerId' | 'peerId' | 'role'>,
) => {
  for (const [key, entry] of ctx.deviceComparisons)
    if (entry.shareId === binding.shareId) ctx.deviceComparisons.delete(key)
  ctx.deviceComparisons.set(result.challenge, {
    ...result,
    shareId: binding.shareId,
    ownPeerId: binding.sourcePeerId,
    peerId: binding.viewerPeerId,
    role: 'sender',
  })
  ctx.publish()
}

export const handleComparisonStream =
  (ctx: SharingContext) =>
  (
    stream: Parameters<typeof createProtocolMessagePort>[0],
    connection: ComparisonConnection,
    expectedShareId?: string,
  ): void => {
    const port = createProtocolMessagePort(stream, (value) =>
      deviceComparisonProtocol.message.parse(value),
    )
    const responder = createComparisonResponder({
      now: Date.now,
      authorize: (shareId) => authorizeComparison(ctx, connection, expectedShareId, shareId),
      reserve: (binding) => ctx.reserveDeviceComparison(binding.shareId, binding.sourcePeerId),
      complete: ({ binding, ...result }) => completeComparison(ctx, binding, result),
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

type StreamState = { authorizedShare?: SourceShare }
type RedeemRequest = { shareId: string; viewerNonce: string; proof: string }

const redeemEndedShare = async (
  ctx: SharingContext,
  session: SourceSession,
  expectedShareId: string | undefined,
  request: RedeemRequest,
) => {
  const ended = ctx.endedShares.get(request.shareId)
  if (
    !ended ||
    ctx.pendingRevocations.has(request.shareId) ||
    ended.endedAt + END_NOTICE_RETENTION_MS <= Date.now() ||
    !(expectedShareId === undefined ? !ended.sourcePrivateKey : expectedShareId === request.shareId)
  )
    return undefined
  const valid = await verifyRedemptionProof(
    base64UrlToBytes(ended.capability.secret),
    {
      shareId: request.shareId,
      sourcePeerId: ended.capability.sourcePeerId,
      viewerPeerId: session.peerId,
      viewerNonce: request.viewerNonce,
    },
    request.proof,
  )
  return valid ? { ended: true as const, reason: ended.reason, endedAt: ended.endedAt } : undefined
}

const redeemCandidate = async (
  ctx: SharingContext,
  session: SourceSession,
  expectedShareId: string | undefined,
  request: RedeemRequest,
) => {
  const candidate = ctx.shares.get(request.shareId)
  const served =
    candidate &&
    (expectedShareId === undefined
      ? candidate.sourcePrivateKey === undefined
      : candidate.capability.shareId === expectedShareId)
  const valid =
    served &&
    candidate &&
    !candidate.redeemedNonces.has(request.viewerNonce) &&
    (candidate.capability.expiresAt === null || Date.now() < candidate.capability.expiresAt) &&
    (await verifyRedemptionProof(
      candidate.secret,
      {
        shareId: request.shareId,
        sourcePeerId: candidate.capability.sourcePeerId,
        viewerPeerId: session.peerId,
        viewerNonce: request.viewerNonce,
      },
      request.proof,
    ))
  if (!candidate || !valid) {
    ctx.recordSessionEvent('redeem-denied')
    throw new Error('Share access denied.')
  }
  return candidate
}

const claimRedeemCandidate = async (
  ctx: SharingContext,
  session: SourceSession,
  candidate: SourceShare,
) => {
  if (candidate.capacity !== 1) return 'claimed' as const
  if (candidate.approvedPeerId && candidate.approvedPeerId !== session.peerId)
    return 'denied' as const
  if (candidate.claimPending) return 'pending' as const
  if (candidate.approvedPeerId === session.peerId) return 'claimed' as const
  if (candidate.requireViewerApproval !== false) {
    const key = ctx.viewerApprovalKey(candidate.capability.shareId, session.peerId)
    if (!ctx.pendingViewerApprovals.has(key)) {
      const pending = [...ctx.pendingViewerApprovals.values()].filter(
        (request) => request.shareId === candidate.capability.shareId,
      ).length
      if (pending >= MAX_PENDING_VIEWER_APPROVALS_PER_SHARE) return 'denied' as const
      ctx.pendingViewerApprovals.set(key, {
        shareId: candidate.capability.shareId,
        peerId: session.peerId,
        fingerprint: session.fingerprint!,
        requestedAt: Date.now(),
      })
      ctx.publish()
    }
    return 'pending' as const
  }
  return claimSingleRecipient(candidate, session.peerId, ctx.persist)
}

const admitRedeemSession = async (
  ctx: SharingContext,
  session: SourceSession,
  candidate: SourceShare,
  viewerNonce: string,
) => {
  if (candidate.sessions.size >= candidate.capacity) {
    ctx.recordSessionEvent('redeem-denied')
    throw new Error('Share access denied.')
  }
  session.sessionId = randomToken()
  session.lastHeartbeatAt = Date.now()
  ctx.pendingViewerApprovals.delete(
    ctx.viewerApprovalKey(candidate.capability.shareId, session.peerId),
  )
  rememberRedeemedNonce(candidate.redeemedNonces, viewerNonce)
  candidate.sessions.add(session)
  if (ctx.rememberViewerPeer(candidate, session.peerId)) {
    try {
      await ctx.persist()
    } catch {
      ctx.publish({ message: 'Authenticated viewer history could not be saved.' })
    }
  }
  ctx.recordSessionEvent('admitted')
  ctx.publish()
}

const handleRedeem = async (
  ctx: SharingContext,
  session: SourceSession,
  state: StreamState,
  expectedShareId: string | undefined,
  request: RedeemRequest,
) => {
  const ended = await redeemEndedShare(ctx, session, expectedShareId, request)
  if (ended) return ended
  const candidate = await redeemCandidate(ctx, session, expectedShareId, request)
  session.fingerprint ??= await viewerFingerprint(request.shareId, session.peerId)
  if (candidate.blockedPeerIds.has(session.peerId)) return { accessDenied: true as const }
  const claim = await claimRedeemCandidate(ctx, session, candidate)
  if (claim === 'denied') return { accessDenied: true as const }
  if (claim === 'pending')
    return { approvalPending: true as const, retryAfterMs: HEARTBEAT_INTERVAL_MS }
  await admitRedeemSession(ctx, session, candidate, request.viewerNonce)
  state.authorizedShare = candidate
  return {
    sessionId: session.sessionId!,
    expiresAt: candidate.capability.expiresAt,
    precision: disclosedPrecisionFor(candidate.precision),
    ...(candidate.name ? { sourceName: candidate.name } : {}),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  }
}

const handleHeartbeat = (
  session: SourceSession,
  state: StreamState,
  request: { sessionId: string },
) => {
  const share = requireAuthorized(session, state.authorizedShare)
  if (session.sessionId !== request.sessionId || !share.sessions.has(session)) {
    throw new Error('Share access denied.')
  }
  session.lastHeartbeatAt = Date.now()
  return { receivedAt: session.lastHeartbeatAt }
}

const handleLeave = (
  ctx: SharingContext,
  session: SourceSession,
  state: StreamState,
  request: { sessionId: string },
) => {
  requireAuthorized(session, state.authorizedShare)
  if (session.sessionId !== request.sessionId) throw new Error('Share access denied.')
  ctx.removeSession(session, 'left')
}

const handleStopFollowing = async (
  ctx: SharingContext,
  session: SourceSession,
  state: StreamState,
  request: { sessionId: string; eventId: string },
) => {
  const share = requireAuthorized(session, state.authorizedShare)
  if (session.sessionId !== request.sessionId || !share.sessions.has(session)) {
    throw new Error('Share access denied.')
  }
  const recordedAt = await recordStoppedViewer(
    ctx.stoppedViewers,
    { shareId: share.capability.shareId, peerId: session.peerId, eventId: request.eventId },
    ctx.persist,
  )
  ctx.removeSession(session, 'left')
  ctx.publish({ message: 'A viewer stopped following.' })
  return { recordedAt }
}

const assertStopNoticeAccess = async (
  ctx: SharingContext,
  session: SourceSession,
  expectedShareId: string | undefined,
  request: { shareId: string; eventId: string; proof: string },
) => {
  const active = ctx.shares.get(request.shareId)
  const ended = ctx.endedShares.get(request.shareId)
  const capability = active?.capability ?? ended?.capability
  const servedHere =
    expectedShareId === undefined
      ? Boolean(capability && !(active?.sourcePrivateKey ?? ended?.sourcePrivateKey))
      : request.shareId === expectedShareId
  if (
    !capability ||
    !servedHere ||
    ctx.pendingRevocations.has(request.shareId) ||
    (ended && Date.now() >= ended.endedAt + END_NOTICE_RETENTION_MS) ||
    (active?.capacity === 1 && active.approvedPeerId !== session.peerId) ||
    (ended?.capacity === 1 && ended.approvedPeerId !== session.peerId) ||
    active?.blockedPeerIds.has(session.peerId) ||
    !(await verifyStopNoticeProof(
      base64UrlToBytes(capability.secret),
      {
        shareId: request.shareId,
        sourcePeerId: capability.sourcePeerId,
        viewerPeerId: session.peerId,
        eventId: request.eventId,
      },
      request.proof,
    ))
  ) {
    throw new Error('Stop notice access denied.')
  }
}

const handleStopNotice = async (
  ctx: SharingContext,
  session: SourceSession,
  expectedShareId: string | undefined,
  request: { shareId: string; eventId: string; proof: string },
) => {
  await assertStopNoticeAccess(ctx, session, expectedShareId, request)
  const recordedAt = await recordStoppedViewer(
    ctx.stoppedViewers,
    { shareId: request.shareId, peerId: session.peerId, eventId: request.eventId },
    ctx.persist,
  )
  ctx.publish({ message: 'A viewer stopped following.' })
  return { recordedAt }
}

const handleOfferReturn = async (
  ctx: SharingContext,
  session: SourceSession,
  state: StreamState,
  request: { sessionId: string; url: string; ownerPeerId: string },
) => {
  const share = requireAuthorized(session, state.authorizedShare)
  if (session.sessionId !== request.sessionId || !share.sessions.has(session)) {
    throw new Error('Share access denied.')
  }
  const offered = parseShareInvitation(request.url)
  if (
    !session.fingerprint ||
    offered.shareId === share.capability.shareId ||
    request.ownerPeerId !== session.peerId ||
    !(await verifyReturnOwner(offered, session.peerId))
  ) {
    throw new Error('Invalid return share.')
  }
  const key = `${share.capability.shareId}:${session.fingerprint}`
  const offer = {
    shareId: share.capability.shareId,
    viewerFingerprint: session.fingerprint,
    ownerPeerId: session.peerId,
    url: request.url,
  }
  ctx.returnOffers.set(key, offer)
  await ctx.persist()
  if (ctx.approvedReturnLinks.has(share.capability.shareId)) {
    try {
      if (await ctx.acceptPendingReturn(key, offer)) {
        ctx.publish({ message: 'A viewer shared back and was accepted automatically.' })
        return
      }
    } catch {
      // Preserve the queued offer for an explicit retry.
    }
  }
  ctx.publish()
}

const handleSensorDescribe = (
  session: SourceSession,
  state: StreamState,
  request: { sensorId: string },
) => {
  requireAuthorized(session, state.authorizedShare)
  if (request.sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
  return {
    sensorId: request.sensorId,
    profile: { id: 'dev.constellation.location', version: '1' },
    descriptorRevision: DESCRIPTOR_REVISION,
  }
}

const handleSensorSubscribe = async (
  ctx: SharingContext,
  session: SourceSession,
  state: StreamState,
  request: { sensorId: string },
) => {
  const share = requireAuthorized(session, state.authorizedShare)
  if (request.sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
  session.subscriptionId = randomToken()
  const initial = await ctx.encryptedObservationMessage(share, session.subscriptionId)
  if (initial) session.send(initial)
  if (
    (ctx.visible || share.publication === 'background') &&
    !ctx.paused &&
    !sharePauseReason(share, ctx.networkRestriction)
  ) {
    ctx.locationSource.refresh()
  }
  return { subscriptionId: session.subscriptionId }
}

const handleSensorUnsubscribe = (
  session: SourceSession,
  state: StreamState,
  request: { subscriptionId: string },
) => {
  requireAuthorized(session, state.authorizedShare)
  if (session.subscriptionId !== request.subscriptionId) {
    throw new Error('Sensor access denied.')
  }
  session.subscriptionId = undefined
}

const createSourceSession = (
  messagePort: ReturnType<typeof createProtocolMessagePort>,
  connection: { remotePeer: { toString: () => string } },
): SourceSession => ({
  peerId: connection.remotePeer.toString(),
  close: () => messagePort.close(),
  closeAfterFlush: () => messagePort.closeAfterFlush(),
  send: messagePort.port.send,
  lastHeartbeatAt: Date.now(),
})

export const handleIncomingStream =
  (ctx: SharingContext) =>
  (
    stream: Parameters<typeof createProtocolMessagePort>[0],
    connection: { remotePeer: { toString: () => string } },
    expectedShareId?: string,
  ): void => {
    ctx.recordSessionEvent('stream-open')
    const messagePort = createProtocolMessagePort(stream, parseConstellationMessage)
    const session = createSourceSession(messagePort, connection)
    const state: StreamState = {}
    const stopServer = createPortServer(
      messagePort.port,
      constellationProtocolV2,
      {
        share: {
          redeem: (request) => handleRedeem(ctx, session, state, expectedShareId, request),
          heartbeat: (request) => handleHeartbeat(session, state, request),
          leave: (request) => handleLeave(ctx, session, state, request),
          stopFollowing: (request) => handleStopFollowing(ctx, session, state, request),
          stopNotice: (request) => handleStopNotice(ctx, session, expectedShareId, request),
          offerReturn: (request) => handleOfferReturn(ctx, session, state, request),
        },
        sensor: {
          describe: (request) => handleSensorDescribe(session, state, request),
          subscribe: (request) => handleSensorSubscribe(ctx, session, state, request),
          unsubscribe: (request) => handleSensorUnsubscribe(session, state, request),
        },
      },
      { onError: () => undefined },
    )
    void messagePort.closed.then(() => {
      stopServer()
      ctx.removeSession(session, 'transport-closed')
    })
  }

type NameStreamPort = ReturnType<typeof createProtocolMessagePort>
type NameConnection = { remotePeer: { toString: () => string } }

const findNameSession = (
  ctx: SharingContext,
  shareId: string,
  sessionId: string,
  peerId: string,
  expectedShareId?: string,
) => {
  const share = ctx.shares.get(shareId)
  const session =
    share &&
    [...share.sessions].find(
      (candidate) => candidate.peerId === peerId && candidate.sessionId === sessionId,
    )
  if (!session || (expectedShareId !== undefined && shareId !== expectedShareId)) {
    throw new Error('Name access denied.')
  }
  requireAuthorized(session, share)
  return { share, session }
}

const addNameListener = (
  ctx: SharingContext,
  port: NameStreamPort,
  shareId: string,
  share: SourceShare,
  session: SourceSession,
  peerId: string,
) => {
  const listener = (name: string | null) => {
    if (!share.sessions.has(session)) return
    try {
      requireAuthorized(session, ctx.shares.get(shareId))
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
  const listeners = ctx.nameListeners.get(peerId) ?? new Set<(name: string | null) => void>()
  listeners.add(listener)
  ctx.nameListeners.set(peerId, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) ctx.nameListeners.delete(peerId)
  }
}

const exchangePeerName = async (
  ctx: SharingContext,
  port: NameStreamPort,
  connection: NameConnection,
  expectedShareId: string | undefined,
  state: { removeListener?: () => void },
  request: { shareId: string; sessionId: string; displayName: string | null },
) => {
  const peerId = connection.remotePeer.toString()
  const { share, session } = findNameSession(
    ctx,
    request.shareId,
    request.sessionId,
    peerId,
    expectedShareId,
  )
  await ctx.receivePeerName(peerId, request.displayName)
  state.removeListener ??= addNameListener(ctx, port, request.shareId, share, session, peerId)
  return { displayName: ctx.namePreference(peerId).sharedName }
}

export const handleNameStream =
  (ctx: SharingContext) =>
  (
    stream: Parameters<typeof createProtocolMessagePort>[0],
    connection: NameConnection,
    expectedShareId?: string,
  ): void => {
    const port = createProtocolMessagePort(stream, (value) =>
      peerNamesProtocol.message.parse(value),
    )
    const state: { removeListener?: () => void } = {}
    const stopServer = createPortServer(
      port.port,
      peerNamesProtocol,
      {
        peerNames: {
          exchange: (request) =>
            exchangePeerName(ctx, port, connection, expectedShareId, state, request),
        },
      },
      { onError: () => undefined },
    )
    void port.closed.then(() => {
      state.removeListener?.()
      stopServer()
    })
  }

export const startPeer = (ctx: SharingContext) => async () => {
  if (!ctx.peer) {
    ctx.publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
    ctx.peer = startPrivateBrowserPeer(ctx.privateKey)
      .then(async (started) => {
        await started.node.handle(SHARE_STREAM_PROTOCOL, ctx.handleIncomingStream, {
          runOnLimitedConnection: true,
        })
        await started.node.handle(PEER_NAMES_PROTOCOL, ctx.handleNameStream, {
          runOnLimitedConnection: true,
        })
        await started.node.handle(DEVICE_COMPARISON_PROTOCOL, ctx.handleComparisonStream, {
          maxInboundStreams: 8,
          runOnLimitedConnection: true,
        })
        ctx.handlerNode = started.node
        ctx.publish({ peerStatus: 'online', message: '' })
        return started
      })
      .catch((error) => {
        ctx.peer = undefined
        ctx.publish({
          peerStatus: 'error',
          message: error instanceof Error ? error.message : 'P2P connection failed.',
        })
        throw error
      })
  }
  return ctx.peer
}

const registerSourcePeerHandlers = async (
  ctx: SharingContext,
  shareId: string,
  node: BrowserLibp2pNode,
) => {
  await node.handle(
    SHARE_STREAM_PROTOCOL,
    (stream, connection) => ctx.handleIncomingStream(stream, connection, shareId),
    { runOnLimitedConnection: true },
  )
  await node.handle(
    PEER_NAMES_PROTOCOL,
    (stream, connection) => ctx.handleNameStream(stream, connection, shareId),
    { runOnLimitedConnection: true },
  )
  await node.handle(
    DEVICE_COMPARISON_PROTOCOL,
    (stream, connection) => ctx.handleComparisonStream(stream, connection, shareId),
    { maxInboundStreams: 8, runOnLimitedConnection: true },
  )
  ctx.sourceNodes.set(shareId, node)
  ctx.publish({ peerStatus: 'online', message: '' })
}

const failSourcePeerStart = (ctx: SharingContext, shareId: string, error: unknown) => {
  ctx.sourceStarts.delete(shareId)
  ctx.publish({
    peerStatus: 'error',
    message: error instanceof Error ? error.message : 'P2P connection failed.',
  })
  throw error
}

export const startSourcePeer =
  (ctx: SharingContext) =>
  (
    share: Pick<SourceShare, 'capability' | 'sourcePrivateKey'>,
  ): Promise<{ node: BrowserLibp2pNode; addresses: string[] }> => {
    if (!share.sourcePrivateKey) return ctx.startPeer()
    const shareId = share.capability.shareId
    const existing = ctx.sourceStarts.get(shareId)
    if (existing) return existing
    ctx.publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
    const starting = startPrivateBrowserPeer(share.sourcePrivateKey)
      .then((started) => registerSourcePeerHandlers(ctx, shareId, started.node).then(() => started))
      .catch((error) => failSourcePeerStart(ctx, shareId, error))
    ctx.sourceStarts.set(shareId, starting)
    return starting
  }

export const stopSourcePeer =
  (ctx: SharingContext) =>
  async (shareId: string): Promise<void> => {
    const starting = ctx.sourceStarts.get(shareId)
    ctx.sourceStarts.delete(shareId)
    let node = ctx.sourceNodes.get(shareId)
    if (!node && starting) {
      try {
        node = (await starting).node
      } catch {
        return
      }
    }
    ctx.sourceNodes.delete(shareId)
    if (!node) return
    await node.unhandle(SHARE_STREAM_PROTOCOL).catch(() => undefined)
    await node.stop()
  }

export const pruneEndNotifications = (ctx: SharingContext) => (): string[] => {
  const retained = new Set(
    retainedEndNotifications([...ctx.endedShares.values()]).map(
      (share) => share.capability.shareId,
    ),
  )
  const removed = [...ctx.endedShares.keys()].filter((shareId) => !retained.has(shareId))
  removed.forEach((shareId) => ctx.endedShares.delete(shareId))
  return removed
}

export const rememberEndNotification =
  (ctx: SharingContext) =>
  (share: SourceShare, reason: 'revoked' | 'expired', endedAt: number): void => {
    ctx.endedShares.set(share.capability.shareId, {
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

export const endFollowing =
  (ctx: SharingContext) =>
  (shareId: string, reason: 'revoked' | 'expired', endedAt: number, name?: string): void => {
    const entry = ctx.followed.get(shareId)
    if (entry) {
      entry.connected = false
      entry.terminal = reason
      entry.endedAt = endedAt
    }
    ctx.received.delete(shareId)
    ctx.pendingReturns.delete(shareId)
    ctx.rememberLifecycleRecord(ctx.oldSeeing, {
      shareId,
      ...(entry?.peerId ? { peerId: entry.peerId } : {}),
      name: entry?.localName ?? name,
      reason,
      endedAt,
    })
  }

export const acceptPendingReturn =
  (ctx: SharingContext) =>
  async (key: string, offer: SharingRuntimeState['returnOffers'][number]): Promise<boolean> => {
    if (ctx.returnShareReceiver === 'external') return false
    const capability = parseShareInvitation(offer.url)
    if (
      hasEndedPeerShare(ctx.oldSeeing.values(), capability.shareId) ||
      ctx.followed.get(capability.shareId)?.terminal
    ) {
      throw new Error('This return location link has ended.')
    }
    await acceptReturnShare(ctx.runtimeApi!, offer, (shareId) =>
      Boolean(ctx.followed.get(shareId)?.connected),
    )
    if (ctx.returnOffers.get(key) !== offer) return false
    ctx.returnOffers.delete(key)
    try {
      await ctx.persist()
    } catch (error) {
      ctx.returnOffers.set(key, offer)
      throw error
    }
    ctx.publish()
    return true
  }

export const ensurePeer = (ctx: SharingContext) => async () => {
  await ctx.prepareState()
  return ctx.startPeer()
}

export const updateShareLocation =
  (ctx: SharingContext) =>
  (share: SourceShare, exact: LocationObservationV1): boolean => {
    if (ctx.paused || sharePauseReason(share, ctx.networkRestriction)) return false
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

export const unsubscribeLocationState = (ctx: SharingContext) =>
  ctx.locationSource.subscribeState((location) => ctx.publish({ location }))

const publishLocationObservation = (ctx: SharingContext, exact: LocationObservationV1) => {
  let privateStateChanged = false
  for (const share of ctx.shares.values()) {
    if (!ctx.visible && share.publication === 'foreground') continue
    if (ctx.updateShareLocation(share, exact)) privateStateChanged = true
    for (const session of share.sessions) {
      if (!session.subscriptionId || !share.latest) continue
      void ctx
        .encryptedObservationMessage(share, session.subscriptionId)
        .then((message) => {
          if (!message) return
          session.send(message)
        })
        .catch(() => ctx.publish({ message: 'Location encryption failed.' }))
    }
  }
  if (privateStateChanged) {
    void ctx
      .persist()
      .catch(() => ctx.publish({ message: 'Private share state could not be saved.' }))
  }
}

export const unsubscribeLocationObservation = (ctx: SharingContext) =>
  ctx.locationSource.subscribeObservation((exact) => publishLocationObservation(ctx, exact))

const dropExpiredStopNotice = async (
  ctx: SharingContext,
  id: string,
  pending: PendingStopNotice,
) => {
  ctx.pendingStopNotices.delete(id)
  try {
    await ctx.persist()
  } catch {
    ctx.pendingStopNotices.set(id, pending)
  }
}

const deliverStopNotice = async (ctx: SharingContext, pending: PendingStopNotice) => {
  const { node } = await ctx.ensurePeer()
  if (ctx.runtimeClosed) return
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
          connection.status === 'open' && connection.remotePeer.toString() === pending.sourcePeerId,
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
}

const completeStopNotice = async (ctx: SharingContext, id: string, pending: PendingStopNotice) => {
  ctx.pendingStopNotices.delete(id)
  try {
    await ctx.persist()
  } catch {
    ctx.pendingStopNotices.set(id, pending)
  }
}

export const retryPendingStopNotices = (ctx: SharingContext) => async (): Promise<void> => {
  if (ctx.retryingStopNotices || ctx.runtimeClosed || !ctx.store || !ctx.privateStateAvailable)
    return
  ctx.retryingStopNotices = true
  try {
    // A bounded batch avoids monopolizing startup or draining the battery.
    for (const [id, pending] of [...ctx.pendingStopNotices].slice(0, 2)) {
      if (ctx.runtimeClosed) break
      if (Date.now() - pending.queuedAt >= STOP_NOTICE_RETENTION_MS) {
        await dropExpiredStopNotice(ctx, id, pending)
        continue
      }
      try {
        // A queued notice contains only a narrow, precomputed stop proof.
        // No original bearer URL or location access secret is retained.
        await deliverStopNotice(ctx, pending)
        await completeStopNotice(ctx, id, pending)
      } catch {
        // Rotate unsuccessful deliveries so unreachable links cannot starve others.
        rotatePendingNotice(ctx.pendingStopNotices, id)
      }
    }
  } finally {
    ctx.retryingStopNotices = false
  }
}

const expireSweptShare = (ctx: SharingContext, share: SourceShare, now: number) => {
  if (share.capability.expiresAt === null || now < share.capability.expiresAt) return
  const endedAt = share.capability.expiresAt
  ctx.rememberEndedShareHistory(
    { shareId: share.capability.shareId, name: share.name, viewerPeerIds: share.viewerPeerIds },
    'expired',
    endedAt,
  )
  ctx.shares.delete(share.capability.shareId)
  ctx.rememberEndNotification(share, 'expired', endedAt)
  const prunedEndIds = ctx.pruneEndNotifications()
  if (!ctx.shares.size) {
    ctx.paused = false
    ctx.locationSource.stop()
  }
  ctx.approvedReturnLinks.delete(share.capability.shareId)
  for (const key of ctx.returnOffers.keys()) {
    if (key.startsWith(`${share.capability.shareId}:`)) ctx.returnOffers.delete(key)
  }
  for (const [key, request] of ctx.pendingViewerApprovals) {
    if (request.shareId === share.capability.shareId) ctx.pendingViewerApprovals.delete(key)
  }
  void Promise.all([ctx.persist(), ...prunedEndIds.map(ctx.stopSourcePeer)]).catch(() =>
    ctx.publish({ message: 'Expired share state could not be saved.' }),
  )
}

const sweepShareSessions = (ctx: SharingContext, share: SourceShare, now: number) => {
  for (const session of [...share.sessions]) {
    const reason = sessionSweepReason(share.capability.expiresAt, session.lastHeartbeatAt, now)
    if (!reason) continue
    if (reason === 'expired' && session.sessionId) {
      session.send(
        constellationProtocolV2.streams['share.sessions'].closed.parse({
          type: 'closed',
          sessionId: session.sessionId,
          reason: 'expired',
        }),
      )
    }
    ctx.removeSession(session, reason)
    void (reason === 'expired' ? session.closeAfterFlush() : session.close())
  }
  expireSweptShare(ctx, share, now)
}

const sweepEndNotifications = (ctx: SharingContext) => {
  const prunedEndIds = ctx.pruneEndNotifications()
  if (!prunedEndIds.length) return
  void Promise.all([ctx.persist(), ...prunedEndIds.map(ctx.stopSourcePeer)]).catch(() =>
    ctx.publish({ message: 'Ended-link notice state could not be saved.' }),
  )
}

const sweepPendingReturns = (ctx: SharingContext, now: number) => {
  let changed = false
  for (const [shareId, url] of ctx.pendingReturns) {
    const entry = ctx.followed.get(shareId)
    try {
      parseShareInvitation(url, now)
      if (entry && !entry.terminal && (entry.expiresAt === null || now < entry.expiresAt)) continue
    } catch {
      // Expired return links cannot be delivered later.
    }
    ctx.pendingReturns.delete(shareId)
    changed = true
  }
  return changed
}

const sweepExpiredFollow = (
  ctx: SharingContext,
  shareId: string,
  entry: FollowEntry,
  now: number,
) => {
  if (
    entry.expiresAt === null ||
    now < entry.expiresAt ||
    entry.terminal === 'expired' ||
    entry.terminal === 'revoked'
  )
    return false
  ctx.endFollowing(shareId, 'expired', entry.expiresAt)
  void ctx.viewerClosers.get(shareId)?.()
  void ctx.persist()
  return true
}

const reconnectFollow = (ctx: SharingContext, shareId: string, entry: FollowEntry, now: number) => {
  if (ctx.returnShareReceiver === 'external') return
  if (entry.connected || ctx.viewerClosers.has(shareId) || ctx.reconnecting.has(shareId)) return
  if (entry.terminal || entry.approvalDenied) return
  try {
    parseShareInvitation(entry.url, now)
  } catch {
    entry.terminal = entry.expiresAt !== null && now >= entry.expiresAt ? 'expired' : 'unavailable'
    if (entry.terminal === 'expired') {
      entry.endedAt = entry.expiresAt ?? now
      ctx.received.delete(shareId)
      ctx.rememberLifecycleRecord(ctx.oldSeeing, {
        shareId,
        ...(entry.peerId ? { peerId: entry.peerId } : {}),
        name: entry.localName,
        reason: 'expired',
        endedAt: entry.endedAt,
      })
      void ctx.persist()
    }
    return
  }
  ctx.reconnecting.add(shareId)
  void ctx
    .runtimeApi!.acceptShare(entry.url, { localName: entry.localName, saved: entry.saved })
    .catch(() => undefined)
    .finally(() => ctx.reconnecting.delete(shareId))
}

const sweepFollows = (ctx: SharingContext, now: number) => {
  for (const [shareId, entry] of ctx.followed) {
    if (sweepExpiredFollow(ctx, shareId, entry, now)) continue
    reconnectFollow(ctx, shareId, entry, now)
  }
}

const pruneRecordedFollows = (ctx: SharingContext, now: number): boolean => {
  let changed = false
  for (const entry of ctx.followed.values()) {
    if (!entry.traceEnabled || !entry.trace?.length) continue
    const retained = pruneFollowTrace(entry.trace, now)
    if (retained.length === entry.trace.length) continue
    entry.trace = retained
    changed = true
  }
  return changed
}

const sweepSharingState = (ctx: SharingContext) => {
  const now = Date.now()
  for (const share of ctx.shares.values()) sweepShareSessions(ctx, share, now)
  sweepEndNotifications(ctx)
  const pendingReturnStateChanged = sweepPendingReturns(ctx, now)
  sweepFollows(ctx, now)
  if (ctx.pendingStopNotices.size && Date.now() >= ctx.stopRetryAt) {
    ctx.stopRetryAt = Date.now() + 30_000
    void ctx.retryPendingStopNotices()
  }
  const tracePruned = pruneRecordedFollows(ctx, now)
  if (pendingReturnStateChanged || tracePruned) {
    void ctx.persist().catch(() => ctx.publish({ message: 'Private history could not be pruned.' }))
  }
  ctx.publish()
}

export const heartbeatSweep = (ctx: SharingContext) =>
  window.setInterval(() => sweepSharingState(ctx), HEARTBEAT_INTERVAL_MS)

export const createSharingHelpers = (ctx: SharingContext) => ({
  namePreference: namePreference(ctx),
  receivePeerName: receivePeerName(ctx),
  viewerApprovalKey,
  insertImportedEntries,
  applyHistoryRecords,
  stoppedViewerKey,
  rememberLifecycleRecord,
  rememberEndedShareHistory: rememberEndedShareHistory(ctx),
  rememberViewerPeer,
  publish: publish(ctx),
  snapshot: snapshot(ctx),
  persist: persist(ctx),
  useEphemeralIdentity: useEphemeralIdentity(ctx),
  prepareState: prepareState(ctx),
  recordSessionEvent: recordSessionEvent(ctx),
  removeSession: removeSession(ctx),
  encryptedObservationMessage: encryptedObservationMessage(ctx),
  comparisonPeerIsEligible: comparisonPeerIsEligible(ctx),
  comparisonIsCurrent: comparisonIsCurrent(ctx),
  reserveDeviceComparison: reserveDeviceComparison(ctx),
  handleComparisonStream: handleComparisonStream(ctx),
  handleIncomingStream: handleIncomingStream(ctx),
  handleNameStream: handleNameStream(ctx),
  startPeer: startPeer(ctx),
  startSourcePeer: startSourcePeer(ctx),
  stopSourcePeer: stopSourcePeer(ctx),
  pruneEndNotifications: pruneEndNotifications(ctx),
  rememberEndNotification: rememberEndNotification(ctx),
  endFollowing: endFollowing(ctx),
  acceptPendingReturn: acceptPendingReturn(ctx),
  ensurePeer: ensurePeer(ctx),
  updateShareLocation: updateShareLocation(ctx),
  retryPendingStopNotices: retryPendingStopNotices(ctx),
})
