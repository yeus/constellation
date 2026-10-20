import { SharingBehavior } from './sharingBehavior.ts'
import type {
  EndedSourceShare,
  FollowEntry,
  FollowStatus,
  FollowSummary,
  NetworkDiagnostics,
  OldShareSummary,
  PeerStatus,
  PendingViewerApproval,
  ReturnOffer,
  SessionEvent,
  ShareSummary,
  SharingRuntime,
  SharingRuntimeState,
  SourceSession,
  SourceShare,
} from './sharingContracts.ts'
import { projectRuntimeState, snapshotPrivateState } from './sharingProjection.ts'


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
  sharePauseState,
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

import type { SharingContext } from './sharingContext.ts'
import {
  FOLLOW_COLORS,
  HEARTBEAT_INTERVAL_MS,
  appendSessionEvent,
  capacityFor,
  claimSingleRecipient,
  randomToken,
  rememberRedeemedNonce,
  requireAuthorized,
  sessionSweepReason,
  viewerFingerprint,
} from './sharingRuntimeHelpers.ts'

export const createLifecycleApi = (ctx: SharingContext): Pick<SharingRuntime, 'setNetworkState' | 'networkDiagnostics' | 'initialize' | 'subscribe' | 'setVisible' | 'setPaused' | 'stop'> => ({
  setNetworkState: createSetNetworkState(ctx),
  networkDiagnostics: createNetworkDiagnostics(ctx),
  initialize: createInitialize(ctx),
  subscribe: createSubscribe(ctx),
  setVisible: createSetVisible(ctx),
  setPaused: createSetPaused(ctx),
  stop: createStop(ctx),
})

const createSetNetworkState = (ctx: SharingContext): SharingRuntime['setNetworkState'] => (restriction) => {
  if (restriction === ctx.networkRestriction) return
  ctx.networkRestriction = restriction
  ctx.publish()
}

const createNetworkDiagnostics = (ctx: SharingContext): SharingRuntime['networkDiagnostics'] => () => ({
  peerStatus: ctx.state.peerStatus,
  sessionEvents: ctx.sessionEvents,
  connections: [
    ...new Set([...(ctx.handlerNode ? [ctx.handlerNode] : []), ...ctx.sourceNodes.values()]),
  ].flatMap((node) =>
    node.getConnections().map((connection) => {
      const peerId = connection.remotePeer.toString()
      const address = connection.remoteAddr.toString()
      const viewer = [...ctx.shares.values()].some((share) =>
        [...share.sessions].some((session) => session.peerId === peerId),
      )
      const source = [...ctx.followed.values()].some((entry) => entry.sourcePeerId === peerId)
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
})

const createInitialize = (ctx: SharingContext): SharingRuntime['initialize'] => async () => {
  await ctx.prepareState()
  if (ctx.pendingStopNotices.size) void ctx.retryPendingStopNotices()
  if (ctx.shares.size > 0 || ctx.endedShares.size > 0) {
    const restoredShares = [...ctx.shares.values(), ...ctx.endedShares.values()]
    if (restoredShares.some((share) => !share.sourcePrivateKey)) await ctx.startPeer()
    await Promise.all(
      restoredShares
        .filter((share) => share.sourcePrivateKey)
        .map((share) => ctx.startSourcePeer(share)),
    )
    if (
      !ctx.paused &&
      ctx.shares.size &&
      (ctx.visible || [...ctx.shares.values()].some((share) => share.publication === 'background'))
    ) {
      ctx.locationSource.start()
    }
  }
  const pending = [...ctx.followed.values()].filter(
    (entry) => ctx.returnShareReceiver === 'local' && !entry.connected && !entry.terminal,
  )
  void Promise.allSettled(
    pending.map((entry) =>
      ctx.runtimeApi!.acceptShare(entry.url, { localName: entry.localName, saved: entry.saved }),
    ),
  )
}

const createSubscribe = (ctx: SharingContext): SharingRuntime['subscribe'] => (observer) => {
  ctx.observers.add(observer)
  observer(ctx.state)
  return () => ctx.observers.delete(observer)
}

const createSetVisible = (ctx: SharingContext): SharingRuntime['setVisible'] => (nextVisible, acquireLocation = true) => {
  ctx.visible = nextVisible
  if (ctx.visible) {
    if (acquireLocation || ctx.shares.size > 0) ctx.locationSource.start()
  } else {
    for (const share of ctx.shares.values()) {
      if (share.publication === 'foreground') share.latest = undefined
    }
    if (![...ctx.shares.values()].some((share) => share.publication === 'background')) {
      ctx.locationSource.stop()
    }
  }
  ctx.publish()
}

const createSetPaused = (ctx: SharingContext): SharingRuntime['setPaused'] => async (nextPaused) => {
  await ctx.prepareState()
  if (ctx.paused === nextPaused) return
  if (nextPaused && !ctx.shares.size) return
  const previous = ctx.paused
  ctx.paused = nextPaused
  try {
    await ctx.persist()
  } catch (error) {
    ctx.paused = previous
    ctx.publish({ message: 'Sharing pause could not be saved.' })
    throw error
  }
  ctx.publish()
}

const createStop = (ctx: SharingContext): SharingRuntime['stop'] => async () => {
  ctx.runtimeClosed = true
  for (const run of ctx.comparisonRuns.values()) {
    run.cancelled = true
    await run.close?.()
  }
  window.clearInterval(ctx.heartbeatSweep)
  if (ctx.noticeTimer !== undefined) window.clearTimeout(ctx.noticeTimer)
  ctx.unsubscribeLocationState()
  ctx.unsubscribeLocationObservation()
  ctx.locationSource.stop()
  await Promise.all([...ctx.viewerClosers.values()].map((close) => close()))
  for (const share of ctx.shares.values()) {
    await Promise.all([...share.sessions].map((session) => session.close()))
  }
  await Promise.all(
    [...new Set([...ctx.sourceStarts.keys(), ...ctx.sourceNodes.keys()])].map((shareId) =>
      ctx.stopSourcePeer(shareId),
    ),
  )
  if (ctx.handlerNode) {
    await ctx.handlerNode.unhandle(SHARE_STREAM_PROTOCOL)
    await ctx.handlerNode.stop()
  }
  ctx.shares.clear()
  ctx.received.clear()
  ctx.followed.clear()
  ctx.observers.clear()
}
