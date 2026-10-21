import type { FollowEntry, SharingRuntime, SourceShare } from './sharingContracts.ts'

import { hasEndedPeerShare } from './peerHistory.ts'
import { appendFollowTrace } from './followTrace.ts'
import { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
export { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
import {
  DEVICE_COMPARISON_PROTOCOL,
  COMPARISON_TTL_MS,
  deviceComparisonProtocol,
  createComparisonCommit,
  finishComparison,
  requireComparisonStreamPeer,
  type DeviceComparison,
} from './deviceComparison.ts'
import { createPortClient } from '@taskyon/protocol'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

import {
  acceptNewerLocationObservation,
  type LocationObservationV1,
} from '../location/locationObservation.ts'
import { createProtocolMessagePort, dialShareStream } from './browserPeer.ts'
import { base64UrlToBytes } from './encoding.ts'
import {
  PeerNamePreference,
  advertisedPeerName,
  nameAfterContact,
  peerNamesProtocol,
  PEER_NAMES_PROTOCOL,
} from './peerNames.ts'
import { createRedemptionProof } from './shareAuth.ts'
import { parseShareInvitation, verifyReturnOwner, type ShareCapability } from './shareLink.ts'
import { decryptLocationPayload } from './sharePayloadCrypto.ts'
import {
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
import { type PendingStopNotice } from './privateStore.ts'

import type { SharingContext } from './sharingContext.ts'
import {
  FOLLOW_COLORS,
  LOCATION_SENSOR_ID,
  randomToken,
  viewerFingerprint,
} from './sharingRuntimeHelpers.ts'

export const createViewerApi = (
  ctx: SharingContext,
): Pick<
  SharingRuntime,
  | 'setPeerNamePreferences'
  | 'adoptPeerName'
  | 'getViewerLabel'
  | 'setViewerLabel'
  | 'blockViewer'
  | 'startDeviceComparison'
  | 'confirmDeviceComparison'
  | 'cancelDeviceComparison'
  | 'acceptShare'
  | 'stopFollowing'
  | 'saveFollowing'
  | 'setFollowName'
  | 'setFollowTraceEnabled'
  | 'clearFollowTrace'
  | 'setFollowColor'
> => ({
  setPeerNamePreferences: createSetPeerNamePreferences(ctx),
  adoptPeerName: createAdoptPeerName(ctx),
  getViewerLabel: createGetViewerLabel(ctx),
  setViewerLabel: createSetViewerLabel(ctx),
  blockViewer: createBlockViewer(ctx),
  startDeviceComparison: createStartDeviceComparison(ctx),
  confirmDeviceComparison: createConfirmDeviceComparison(ctx),
  cancelDeviceComparison: createCancelDeviceComparison(ctx),
  acceptShare: createAcceptShare(ctx),
  stopFollowing: createStopFollowing(ctx),
  saveFollowing: createSaveFollowing(ctx),
  setFollowName: createSetFollowName(ctx),
  setFollowTraceEnabled: createSetFollowTraceEnabled(ctx),
  clearFollowTrace: createClearFollowTrace(ctx),
  setFollowColor: createSetFollowColor(ctx),
})

const createSetPeerNamePreferences =
  (ctx: SharingContext): SharingRuntime['setPeerNamePreferences'] =>
  async (peerId, associateNames, sharedName) => {
    await ctx.prepareState()
    const known =
      [...ctx.followed.values()].some((entry) => entry.peerId === peerId) ||
      [...ctx.shares.values()].some((share) =>
        [...share.sessions].some((session) => session.peerId === peerId),
      )
    if (!known) throw new Error('This peer has no authenticated location relationship.')
    if (!ctx.store || !ctx.privateStateAvailable)
      throw new Error('Protected storage is unavailable.')
    if (ctx.peerNamePreferences.size >= 1_024 && !ctx.peerNamePreferences.has(peerId))
      throw new Error('Too many remembered peers.')
    const previous = ctx.namePreference(peerId)
    const next = PeerNamePreference.parse({ ...previous, associateNames, sharedName })
    ctx.peerNamePreferences.set(peerId, next)
    try {
      await ctx.persist()
    } catch (error) {
      ctx.peerNamePreferences.set(peerId, previous)
      throw error
    }
    ctx.nameListeners.get(peerId)?.forEach((send) => send(next.sharedName))
    const results = await Promise.allSettled(
      [...ctx.followed.entries()]
        .filter(([, entry]) => entry.peerId === peerId)
        .flatMap(([shareId]) => {
          const sender = ctx.nameSenders.get(shareId)
          return sender ? [sender.send(next.sharedName)] : []
        }),
    )
    ctx.publish()
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Name preference saved; delivery will retry when this peer reconnects.')
  }

const prepareNameAdoption = async (ctx: SharingContext, peerId: string, name: string) => {
  const previous = ctx.peerNamePreferences.get(peerId)
  const entries = [...ctx.followed.values()].filter((entry) => entry.peerId === peerId)
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
    [...ctx.shares.keys()].map(
      async (shareId) => `${shareId}:${await viewerFingerprint(shareId, peerId)}`,
    ),
  )
  const previousLabels = labelKeys.map((key) => ({ key, name: ctx.viewerLabels.get(key) }))
  if (advertisedPeerName(ctx.peerNamePreferences.get(peerId), linkName) !== name) {
    throw new Error('The advertised name changed. Review the latest name and retry.')
  }
  return { previous, entries, previousEntries, labelKeys, previousLabels }
}

const applyNameAdoption = (
  ctx: SharingContext,
  peerId: string,
  name: string,
  entries: FollowEntry[],
  labelKeys: string[],
) => {
  ctx.peerNamePreferences.set(peerId, {
    ...ctx.namePreference(peerId),
    acceptedName: name,
    nickname: undefined,
  })
  entries.forEach((entry) => {
    entry.localName = name
    entry.usesPrivateName = false
  })
  labelKeys.forEach((key) => ctx.viewerLabels.delete(key))
}

const rollbackNameAdoption = (
  ctx: SharingContext,
  peerId: string,
  adoption: Awaited<ReturnType<typeof prepareNameAdoption>>,
) => {
  if (adoption.previous) ctx.peerNamePreferences.set(peerId, adoption.previous)
  else ctx.peerNamePreferences.delete(peerId)
  adoption.previousEntries.forEach(({ entry, localName, usesPrivateName }) => {
    entry.localName = localName
    entry.usesPrivateName = usesPrivateName
  })
  adoption.previousLabels.forEach(({ key, name }) => {
    if (name) ctx.viewerLabels.set(key, name)
  })
  ctx.publish()
}

const createAdoptPeerName =
  (ctx: SharingContext): SharingRuntime['adoptPeerName'] =>
  async (peerId, name) => {
    await ctx.prepareState()
    const adoption = await prepareNameAdoption(ctx, peerId, name)
    applyNameAdoption(ctx, peerId, name, adoption.entries, adoption.labelKeys)
    try {
      await ctx.persist()
    } catch (error) {
      rollbackNameAdoption(ctx, peerId, adoption)
      throw error
    }
    ctx.publish()
  }

const createGetViewerLabel =
  (ctx: SharingContext): SharingRuntime['getViewerLabel'] =>
  (shareId, fingerprint) =>
    ctx.viewerLabels.get(`${shareId}:${fingerprint}`)

const createSetViewerLabel =
  (ctx: SharingContext): SharingRuntime['setViewerLabel'] =>
  async (shareId, fingerprint, name) => {
    await ctx.prepareState()
    const key = `${shareId}:${fingerprint}`
    const previous = ctx.viewerLabels.get(key)
    const next = name.trim().slice(0, 32)
    if (next) ctx.viewerLabels.set(key, next)
    else ctx.viewerLabels.delete(key)
    if (ctx.viewerLabels.size > 1_024) {
      if (previous) ctx.viewerLabels.set(key, previous)
      else ctx.viewerLabels.delete(key)
      throw new Error('Too many saved device names.')
    }
    try {
      await ctx.persist()
    } catch (error) {
      if (previous) ctx.viewerLabels.set(key, previous)
      else ctx.viewerLabels.delete(key)
      throw error
    }
    ctx.publish()
  }

const collectViewerBlockTargets = (
  ctx: SharingContext,
  share: SourceShare,
  shareId: string,
  fingerprint: string,
) => {
  const sessions = [...share.sessions].filter((session) => session.fingerprint === fingerprint)
  const pending = [...ctx.pendingViewerApprovals.entries()].filter(
    ([, request]) => request.shareId === shareId && request.fingerprint === fingerprint,
  )
  const peerIds = [
    ...new Set([
      ...sessions.map((session) => session.peerId),
      ...pending.map(([, request]) => request.peerId),
    ]),
  ]
  return { sessions, pending, peerIds }
}

const createBlockViewer =
  (ctx: SharingContext): SharingRuntime['blockViewer'] =>
  async (shareId, fingerprint) => {
    await ctx.prepareState()
    const share = ctx.shares.get(shareId)
    if (!share) throw new Error('This share is no longer available.')
    const { sessions, pending, peerIds } = collectViewerBlockTargets(
      ctx,
      share,
      shareId,
      fingerprint,
    )
    if (peerIds.length === 0) throw new Error('This device is no longer connected.')
    if (share.blockedPeerIds.size + peerIds.length > 128) {
      throw new Error('Too many blocked devices on this link; revoke the link instead.')
    }
    for (const peerId of peerIds) share.blockedPeerIds.add(peerId)
    try {
      await ctx.persist()
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
    pending.forEach(([key]) => ctx.pendingViewerApprovals.delete(key))
    ctx.recordSessionEvent('blocked')
    ctx.publish()
    await Promise.all(sessions.map((session) => session.closeAfterFlush()))
  }

const prepareViewerComparison = async (ctx: SharingContext, shareId: string) => {
  await ctx.prepareState()
  const follow = ctx.followed.get(shareId)
  if (
    !ctx.store ||
    !ctx.privateStateAvailable ||
    !follow ||
    follow.terminal ||
    follow.approvalDenied ||
    ctx.comparisonRuns.has(shareId)
  ) {
    throw new Error('Device comparison is unavailable.')
  }
  const capability = parseShareInvitation(follow.url)
  const { node } = await ctx.ensurePeer()
  const ownPeerId = node.peerId.toString()
  const run: { cancelled: boolean; close?: () => Promise<void> } = { cancelled: false }
  ctx.comparisonRuns.set(shareId, run)
  return { follow, capability, node, ownPeerId, run }
}

const openComparisonPort = async (node: BrowserLibp2pNode, capability: ShareCapability) => {
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
  return createProtocolMessagePort(stream, (value) => deviceComparisonProtocol.message.parse(value))
}

const assertComparisonResult = (
  ctx: SharingContext,
  shareId: string,
  follow: FollowEntry,
  run: { cancelled: boolean },
  result: { expiresAt: number },
) => {
  if (
    run.cancelled ||
    Date.now() >= result.expiresAt ||
    result.expiresAt > Date.now() + COMPARISON_TTL_MS ||
    ctx.followed.get(shareId) !== follow
  ) {
    throw new Error('Device comparison expired or cancelled.')
  }
}

const storeViewerComparison = (
  ctx: SharingContext,
  shareId: string,
  capability: ShareCapability,
  ownPeerId: string,
  result: Omit<DeviceComparison, 'shareId' | 'peerId' | 'ownPeerId' | 'role'>,
) => {
  for (const [key, entry] of ctx.deviceComparisons) {
    if (entry.shareId === shareId) ctx.deviceComparisons.delete(key)
  }
  ctx.deviceComparisons.set(result.challenge, {
    ...result,
    shareId,
    peerId: capability.sourcePeerId,
    ownPeerId,
    role: 'viewer',
  })
  ctx.publish()
}

const finishViewerComparison = async (
  ctx: SharingContext,
  shareId: string,
  follow: FollowEntry,
  capability: ShareCapability,
  ownPeerId: string,
  run: { cancelled: boolean },
  port: ReturnType<typeof createProtocolMessagePort>,
) => {
  if (run.cancelled) throw new Error('Device comparison cancelled.')
  const client = createPortClient(port.port, deviceComparisonProtocol)
  const binding = { shareId, sourcePeerId: capability.sourcePeerId, viewerPeerId: ownPeerId }
  const secret = base64UrlToBytes(capability.secret)
  const commit = await createComparisonCommit(secret, binding)
  const result = await finishComparison(
    secret,
    binding,
    commit,
    await client.comparison.commit(commit.request),
    (request) => client.comparison.reveal(request),
  )
  assertComparisonResult(ctx, shareId, follow, run, result)
  storeViewerComparison(ctx, shareId, capability, ownPeerId, result)
}

const createStartDeviceComparison =
  (ctx: SharingContext): SharingRuntime['startDeviceComparison'] =>
  async (shareId) => {
    const { follow, capability, node, ownPeerId, run } = await prepareViewerComparison(ctx, shareId)
    try {
      await ctx.reserveDeviceComparison(shareId, ownPeerId)
      const port = await openComparisonPort(node, capability)
      run.close = () => port.close()
      try {
        await finishViewerComparison(ctx, shareId, follow, capability, ownPeerId, run, port)
      } finally {
        await port.close()
      }
    } finally {
      ctx.comparisonRuns.delete(shareId)
    }
  }

const createConfirmDeviceComparison =
  (ctx: SharingContext): SharingRuntime['confirmDeviceComparison'] =>
  async (shareId, challenge) => {
    await ctx.prepareState()
    const entry = ctx.deviceComparisons.get(challenge)
    if (
      !entry ||
      entry.shareId !== shareId ||
      !ctx.comparisonIsCurrent(entry) ||
      Date.now() >= entry.expiresAt
    )
      throw new Error('Device comparison expired or cancelled.')
    if (
      entry.role === 'viewer' &&
      (await ctx.ensurePeer()).node.peerId.toString() !== entry.ownPeerId
    )
      throw new Error('Device identity changed.')
    const next = { ...entry, confirmedAt: Date.now() }
    ctx.deviceComparisons.set(challenge, next)
    try {
      await ctx.persist()
    } catch (error) {
      ctx.deviceComparisons.set(challenge, entry)
      throw error
    }
    ctx.publish()
  }

const createCancelDeviceComparison =
  (ctx: SharingContext): SharingRuntime['cancelDeviceComparison'] =>
  async (shareId, challenge) => {
    await ctx.prepareState()
    const run = ctx.comparisonRuns.get(shareId)
    if (run) {
      run.cancelled = true
      await run.close?.()
    }
    const entry = ctx.deviceComparisons.get(challenge)
    if (entry?.shareId === shareId) ctx.deviceComparisons.delete(challenge)
    await ctx.persist()
    ctx.publish()
  }

type AcceptShareOptions = { localName?: string; saved?: boolean; returnOwnerPeerId?: string }
type FollowPort = ReturnType<typeof createProtocolMessagePort>
type FollowCloser = (explicit?: boolean, eventId?: string) => Promise<boolean>

const openFollowClient = (messagePort: FollowPort) =>
  createPortClient(messagePort.port, constellationProtocolV2)
type FollowClient = ReturnType<typeof openFollowClient>
type FollowSession = Awaited<ReturnType<FollowClient['share']['redeem']>>
type ActiveFollowSession = Extract<FollowSession, { sessionId: string }>
type FollowCloseResult = Awaited<FollowPort['closed']>

type FollowState = {
  url: string
  capability: ShareCapability
  knownPeerId?: string
  options: AcceptShareOptions
  node: BrowserLibp2pNode
  messagePort: FollowPort
  client: FollowClient
  previousFollow?: FollowEntry
  previousObservation?: LocationObservationV1
  earlyClosedMessage?: ConstellationMessage
  stopBufferingClose: () => void
  activeSubscription: { id?: string }
  pendingObservation: unknown
  awaitingFirstObservation: boolean
  unsubscribe?: () => void
  heartbeat?: number
  close?: FollowCloser
}

const prepareAcceptance = async (ctx: SharingContext, url: string, options: AcceptShareOptions) => {
  if (ctx.returnShareReceiver === 'external') {
    throw new Error('Returned locations belong to the foreground receiver.')
  }
  if (!ctx.store && options.saved !== false) {
    throw new Error('Protected storage is not configured; preview only.')
  }
  await ctx.prepareState()
  const capability = parseShareInvitation(url)
  const knownPeerId =
    capability.ownerPeerId && (await verifyReturnOwner(capability))
      ? capability.ownerPeerId
      : undefined
  if (
    ctx.followed.get(capability.shareId)?.terminal ||
    hasEndedPeerShare(ctx.oldSeeing.values(), capability.shareId)
  ) {
    throw new Error('This location link has ended.')
  }
  if (
    options.returnOwnerPeerId &&
    !(await verifyReturnOwner(capability, options.returnOwnerPeerId))
  ) {
    throw new Error('This return link was not created by the connected viewer.')
  }
  if (ctx.followed.get(capability.shareId)?.connected) {
    throw new Error('Already following this link.')
  }
  const { node } = await ctx.ensurePeer()
  return { capability, knownPeerId, node }
}

const openFollowStream = async (node: BrowserLibp2pNode, capability: ShareCapability) => {
  const stream = await dialShareStream(
    node,
    capability.addresses,
    SHARE_STREAM_PROTOCOL,
    node
      .getConnections()
      .filter(
        (connection) =>
          connection.status === 'open' &&
          connection.remotePeer.toString() === capability.sourcePeerId,
      ),
  )
  const messagePort = createProtocolMessagePort(stream, parseConstellationMessage)
  return { messagePort, client: openFollowClient(messagePort) }
}

const createFollowState = (
  ctx: SharingContext,
  url: string,
  capability: ShareCapability,
  knownPeerId: string | undefined,
  options: AcceptShareOptions,
  node: BrowserLibp2pNode,
  messagePort: FollowPort,
  client: FollowClient,
): FollowState => {
  const state: FollowState = {
    url,
    capability,
    knownPeerId,
    options,
    node,
    messagePort,
    client,
    previousFollow: ctx.followed.get(capability.shareId),
    previousObservation: ctx.received.get(capability.shareId),
    stopBufferingClose: () => undefined,
    activeSubscription: {},
    pendingObservation: undefined,
    awaitingFirstObservation: true,
  }
  state.stopBufferingClose = messagePort.port.receive((message) => {
    if (constellationProtocolV2.streams['share.sessions'].closed.safeParse(message).success) {
      state.earlyClosedMessage = message as ConstellationMessage
    }
  })
  return state
}

const redeemFollow = async (
  capability: ShareCapability,
  node: BrowserLibp2pNode,
  client: FollowClient,
) => {
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
  return session
}

const handleEndedFollow = async (
  ctx: SharingContext,
  state: FollowState,
  session: Extract<FollowSession, { ended: true }>,
) => {
  ctx.endFollowing(
    state.capability.shareId,
    session.reason,
    session.endedAt,
    state.options.localName ?? generatedFollowName(state.capability.shareId),
  )
  await ctx.persist()
  await state.messagePort.close()
  ctx.publish({
    message:
      session.reason === 'revoked'
        ? 'The sender revoked this location link.'
        : 'This location link expired.',
  })
  throw new Error('This location link has ended.')
}

const pendingFollowEntry = (
  ctx: SharingContext,
  state: FollowState,
  denied: boolean,
): FollowEntry => {
  const existing = ctx.followed.get(state.capability.shareId)
  const existingPeer = [...ctx.followed.values()].find(
    (entry) => entry.sourcePeerId === state.capability.sourcePeerId,
  )
  return {
    url: state.url,
    sourcePeerId: state.capability.sourcePeerId,
    peerId: state.knownPeerId,
    sourceName: existing?.sourceName,
    linkSourceName: existing?.linkSourceName,
    usesPrivateName: existing?.usesPrivateName ?? Boolean(state.options.localName?.trim()),
    localName:
      existing?.localName ??
      (state.options.localName?.trim() || generatedFollowName(state.capability.shareId)),
    color:
      existing?.color ??
      existingPeer?.color ??
      FOLLOW_COLORS[ctx.followed.size % FOLLOW_COLORS.length]!,
    connected: false,
    approvalPending: !denied,
    approvalDenied: denied,
    saved: existing?.saved ?? state.options.saved ?? true,
    followedAt: existing?.followedAt ?? Date.now(),
    returnPromptSeen: existing?.returnPromptSeen ?? Boolean(state.options.returnOwnerPeerId),
    updatesReceived: existing?.updatesReceived ?? 0,
    traceEnabled: existing?.traceEnabled ?? false,
    ...(existing?.traceEnabled ? { trace: existing.trace } : {}),
    expiresAt: state.capability.expiresAt,
  }
}

const applyPendingFollow = async (ctx: SharingContext, state: FollowState, denied: boolean) => {
  const entry = pendingFollowEntry(ctx, state, denied)
  ctx.followed.set(state.capability.shareId, entry)
  if (denied) ctx.received.delete(state.capability.shareId)
  if (ctx.followed.get(state.capability.shareId)?.saved) await ctx.persist()
  await state.messagePort.close()
  ctx.publish({
    message: denied
      ? 'The sender did not approve this device for the location share.'
      : 'Waiting for the sender to approve this device.',
  })
}

const activeFollowEntry = (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
): FollowEntry => {
  const existing = ctx.followed.get(state.capability.shareId)
  const existingPeer = [...ctx.followed.values()].find(
    (entry) => entry.sourcePeerId === state.capability.sourcePeerId,
  )
  return {
    url: state.url,
    sourcePeerId: state.capability.sourcePeerId,
    peerId: state.knownPeerId,
    sourceName: session.sourceName,
    linkSourceName: session.sourceName,
    usesPrivateName: existing?.usesPrivateName ?? Boolean(state.options.localName?.trim()),
    localName: nameAfterContact(
      existing,
      session.sourceName,
      existing ? undefined : state.options.localName,
      generatedFollowName(state.capability.shareId),
    ),
    color:
      existing?.color ??
      existingPeer?.color ??
      FOLLOW_COLORS[ctx.followed.size % FOLLOW_COLORS.length]!,
    connected: true,
    approvalPending: false,
    approvalDenied: false,
    saved: existing?.saved ?? state.options.saved ?? true,
    followedAt: existing ? existing.followedAt : Date.now(),
    returnPromptSeen: existing?.returnPromptSeen ?? Boolean(state.options.returnOwnerPeerId),
    updatesReceived: existing?.updatesReceived ?? 0,
    traceEnabled: existing?.traceEnabled ?? false,
    ...(existing?.traceEnabled ? { trace: existing.trace } : {}),
    expiresAt: state.capability.expiresAt,
  }
}

const applyActiveFollow = (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
) => {
  ctx.followed.set(state.capability.shareId, activeFollowEntry(ctx, state, session))
}

const receiveObservation = async (
  ctx: SharingContext,
  state: FollowState,
  envelope: { sequence: number; capturedAt: number; expiresAt: number; payload: unknown },
) => {
  try {
    const observation = await decryptLocationPayload(
      base64UrlToBytes(state.capability.secret),
      state.capability.shareId,
      envelope.payload,
    )
    if (
      observation.sequence !== envelope.sequence ||
      observation.capturedAt !== envelope.capturedAt ||
      observation.expiresAt !== envelope.expiresAt
    ) {
      throw new Error('Location envelope metadata does not match its encrypted payload.')
    }
    const current = ctx.received.get(state.capability.shareId)
    const newSource = state.awaitingFirstObservation && current?.sourceId !== observation.sourceId
    if (!newSource && !acceptNewerLocationObservation(current, observation)) return
    state.awaitingFirstObservation = false
    ctx.received.set(state.capability.shareId, observation)
    const entry = ctx.followed.get(state.capability.shareId)
    if (entry) entry.updatesReceived += 1
    if (entry?.traceEnabled) {
      entry.trace = appendFollowTrace(entry.trace ?? [], {
        type: 'location',
        observation,
        receivedAt: Date.now(),
      })
      scheduleTracePersist(ctx)
    }
    ctx.publish({ message: '' })
  } catch {
    // Invalid or unauthenticated location payloads are ignored without retaining their data.
  }
}

const receiveClosedMessage = (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
  closed: Extract<ConstellationMessage, { type: 'closed' }>,
) => {
  const entry = ctx.followed.get(state.capability.shareId)
  if (entry) {
    if (entry?.traceEnabled) {
      entry.trace = appendFollowTrace(entry.trace ?? [], {
        type: 'closed',
        receivedAt: Date.now(),
        reason: closed.reason,
      })
      scheduleTracePersist(ctx)
    }
    entry.connected = false
    if (closed.reason === 'expired' || closed.reason === 'revoked') {
      entry.terminal = closed.reason
    }
  }
  if (entry && (entry.terminal === 'expired' || entry.terminal === 'revoked')) {
    ctx.endFollowing(
      state.capability.shareId,
      entry.terminal,
      entry.terminal === 'expired' ? (entry.expiresAt ?? Date.now()) : Date.now(),
    )
    void ctx
      .persist()
      .catch(() => ctx.publish({ message: 'Ended location history could not be saved.' }))
  }
  ctx.publish({
    message:
      closed.reason === 'expired'
        ? 'This location link expired.'
        : closed.reason === 'revoked'
          ? 'The sender revoked your access to this location.'
          : 'The location connection closed. Reconnecting…',
  })
  void state.messagePort.close()
}

const receiveFollowMessage = (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
  message: unknown,
) => {
  const closed = constellationProtocolV2.streams['share.sessions'].closed.safeParse(message)
  if (closed.success && closed.data.sessionId === session.sessionId) {
    receiveClosedMessage(ctx, state, session, closed.data)
    return
  }
  const parsed =
    constellationProtocolV2.streams['sensor.observations'].observation.safeParse(message)
  if (!parsed.success) return
  if (!state.activeSubscription.id) {
    state.pendingObservation = parsed.data
    return
  }
  if (parsed.data.subscriptionId === state.activeSubscription.id) {
    void receiveObservation(ctx, state, parsed.data.observation)
  }
}

const subscribeFollow = async (ctx: SharingContext, state: FollowState) => {
  await state.client.sensor.describe({ sensorId: LOCATION_SENSOR_ID })
  const subscription = await state.client.sensor.subscribe({ sensorId: LOCATION_SENSOR_ID })
  state.activeSubscription.id = subscription.subscriptionId
  const pending = constellationProtocolV2.streams['sensor.observations'].observation.safeParse(
    state.pendingObservation,
  )
  if (pending.success && pending.data.subscriptionId === state.activeSubscription.id) {
    await receiveObservation(ctx, state, pending.data.observation)
  }
}

const startFollowHeartbeat = (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
) =>
  window.setInterval(() => {
    void state.client.share.heartbeat({ sessionId: session.sessionId }).catch(() => {
      ctx.recordSessionEvent('heartbeat-failed')
      const entry = ctx.followed.get(state.capability.shareId)
      if (entry) entry.connected = false
      ctx.publish({ message: 'The location connection was lost.' })
      void state.messagePort.close()
    })
  }, session.heartbeatIntervalMs)

const createFollowCloser =
  (
    state: FollowState,
    session: ActiveFollowSession,
    heartbeat: number,
    unsubscribe: () => void,
  ): FollowCloser =>
  async (explicit = false, eventId) => {
    window.clearInterval(heartbeat)
    unsubscribe()
    try {
      if (explicit) {
        await state.client.share.stopFollowing({
          sessionId: session.sessionId,
          eventId: eventId ?? randomToken(),
        })
      } else {
        await state.client.share.leave({ sessionId: session.sessionId })
      }
      return true
    } catch {
      return false
    } finally {
      await state.messagePort.close()
    }
  }

const openFollowNameChannel = async (
  ctx: SharingContext,
  state: FollowState,
  knownPeerId: string,
  sessionId: string,
) => {
  const names = await dialShareStream(
    state.node,
    state.capability.addresses,
    PEER_NAMES_PROTOCOL,
    state.node
      .getConnections()
      .filter((connection) => connection.remotePeer.toString() === state.capability.sourcePeerId),
  )
  const namesPort = createProtocolMessagePort(names, (value) =>
    peerNamesProtocol.message.parse(value),
  )
  const namesClient = createPortClient(namesPort.port, peerNamesProtocol)
  const removeNames = namesPort.port.receive((message) => {
    const change = peerNamesProtocol.streams['peerNames.profile'].changed.safeParse(message)
    if (change.success) void ctx.receivePeerName(knownPeerId, change.data.displayName)
  })
  return {
    send: async (displayName: string | null) => {
      const response = await namesClient.peerNames.exchange({
        shareId: state.capability.shareId,
        sessionId,
        displayName,
      })
      await ctx.receivePeerName(knownPeerId, response.displayName)
    },
    close: async () => {
      removeNames()
      await namesPort.close()
    },
  }
}

const registerFollowNameChannel = async (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
  knownPeerId: string,
) => {
  try {
    const channel = await openFollowNameChannel(ctx, state, knownPeerId, session.sessionId)
    ctx.nameSenders.set(state.capability.shareId, { send: channel.send, close: channel.close })
    void state.messagePort.closed.then(() => {
      if (ctx.nameSenders.get(state.capability.shareId)?.close === channel.close) {
        ctx.nameSenders.delete(state.capability.shareId)
      }
      void channel.close()
    })
    await channel.send(ctx.namePreference(knownPeerId).sharedName)
  } catch {
    // Older clients have no name capability. Location sharing remains usable.
  }
}

const flushQueuedReturn = async (ctx: SharingContext, state: FollowState) => {
  const queuedReturn = ctx.pendingReturns.get(state.capability.shareId)
  if (!queuedReturn) return
  try {
    await ctx.returnSenders.get(state.capability.shareId)!(queuedReturn)
    ctx.pendingReturns.delete(state.capability.shareId)
    await ctx.persist()
  } catch {
    ctx.publish({ message: 'Return link is queued until the original sharer reconnects.' })
  }
}

const persistActiveFollow = async (
  ctx: SharingContext,
  state: FollowState,
  close: FollowCloser,
) => {
  try {
    if (ctx.followed.get(state.capability.shareId)?.saved) await ctx.persist()
  } catch (error) {
    ctx.viewerClosers.delete(state.capability.shareId)
    ctx.returnSenders.delete(state.capability.shareId)
    if (state.previousFollow) ctx.followed.set(state.capability.shareId, state.previousFollow)
    else ctx.followed.delete(state.capability.shareId)
    await close()
    throw error
  }
}

const onFollowClosed =
  (
    ctx: SharingContext,
    state: FollowState,
    close: FollowCloser,
    heartbeat: number,
    unsubscribe: () => void,
  ) =>
  (result: FollowCloseResult) => {
    window.clearInterval(heartbeat)
    unsubscribe()
    if (ctx.viewerClosers.get(state.capability.shareId) !== close) return
    ctx.viewerClosers.delete(state.capability.shareId)
    ctx.returnSenders.delete(state.capability.shareId)
    const entry = ctx.followed.get(state.capability.shareId)
    if (entry) {
      entry.connected = false
      if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
        ctx.endFollowing(state.capability.shareId, 'expired', entry.expiresAt)
        void ctx
          .persist()
          .catch(() => ctx.publish({ message: 'Ended location history could not be saved.' }))
      }
    }
    if (result.reason !== 'local') {
      ctx.recordSessionEvent('transport-closed')
      ctx.publish({ message: 'The location connection closed. Reconnecting…' })
    }
    ctx.publish()
  }

const activateFollow = async (
  ctx: SharingContext,
  state: FollowState,
  session: ActiveFollowSession,
) => {
  const unsubscribe = state.messagePort.port.receive((message) =>
    receiveFollowMessage(ctx, state, session, message),
  )
  state.unsubscribe = unsubscribe
  state.stopBufferingClose()
  if (state.earlyClosedMessage) receiveFollowMessage(ctx, state, session, state.earlyClosedMessage)
  if (hasEndedPeerShare(ctx.oldSeeing.values(), state.capability.shareId)) {
    unsubscribe()
    throw new Error('This location link has ended.')
  }
  await subscribeFollow(ctx, state)
  const heartbeat = startFollowHeartbeat(ctx, state, session)
  const close = createFollowCloser(state, session, heartbeat, unsubscribe)
  state.heartbeat = heartbeat
  state.close = close
  ctx.viewerClosers.set(state.capability.shareId, close)
  ctx.returnSenders.set(state.capability.shareId, (url) =>
    state.client.share.offerReturn({
      sessionId: session.sessionId,
      url,
      ownerPeerId: state.node.peerId.toString(),
    }),
  )
  if (state.knownPeerId) {
    await registerFollowNameChannel(ctx, state, session, state.knownPeerId)
  }
  await flushQueuedReturn(ctx, state)
  await persistActiveFollow(ctx, state, close)
  void state.messagePort.closed.then(onFollowClosed(ctx, state, close, heartbeat, unsubscribe))
  ctx.publish({
    message: ctx.received.has(state.capability.shareId) ? '' : 'Waiting for the first location…',
  })
}

const rollbackAcceptedFollow = async (ctx: SharingContext, state: FollowState) => {
  if (hasEndedPeerShare(ctx.oldSeeing.values(), state.capability.shareId)) {
    ctx.publish()
  } else {
    if (state.previousFollow) ctx.followed.set(state.capability.shareId, state.previousFollow)
    else ctx.followed.delete(state.capability.shareId)
    if (state.previousObservation) {
      ctx.received.set(state.capability.shareId, state.previousObservation)
    }
  }
  await state.messagePort.close()
}

const createAcceptShare =
  (ctx: SharingContext): SharingRuntime['acceptShare'] =>
  async (url, options = {}) => {
    const { capability, knownPeerId, node } = await prepareAcceptance(ctx, url, options)
    const { messagePort, client } = await openFollowStream(node, capability)
    const state = createFollowState(
      ctx,
      url,
      capability,
      knownPeerId,
      options,
      node,
      messagePort,
      client,
    )
    try {
      const session = await redeemFollow(capability, node, client)
      if ('ended' in session) return await handleEndedFollow(ctx, state, session)
      if ('approvalPending' in session || 'accessDenied' in session) {
        await applyPendingFollow(ctx, state, 'accessDenied' in session)
        return
      }
      applyActiveFollow(ctx, state, session)
      await activateFollow(ctx, state, session)
    } catch (error) {
      await rollbackAcceptedFollow(ctx, state)
      throw error
    } finally {
      state.stopBufferingClose()
    }
  }

const preparePendingStop = async (ctx: SharingContext, entry: FollowEntry, eventId: string) => {
  const shouldQueue = shouldQueueStopNotice(
    Boolean(ctx.store && ctx.privateKey),
    ctx.privateStateAvailable,
  )
  const pending: PendingStopNotice | undefined =
    shouldQueue && ctx.privateKey
      ? await preparePendingStopNotice(
          entry.url,
          eventId,
          peerIdFromPrivateKey(ctx.privateKey).toString(),
        )
      : undefined
  return { shouldQueue, pending }
}

const queuePendingStop = (ctx: SharingContext, pending: PendingStopNotice | undefined) => {
  const previous = new Map(ctx.pendingStopNotices)
  if (!pending) return previous
  ctx.pendingStopNotices.set(pending.eventId, pending)
  while (ctx.pendingStopNotices.size > 128) {
    const oldest = ctx.pendingStopNotices.keys().next().value
    if (oldest) ctx.pendingStopNotices.delete(oldest)
  }
  return previous
}

const restoreFollowingState = (
  ctx: SharingContext,
  shareId: string,
  entry: FollowEntry,
  observation: LocationObservationV1 | undefined,
  pendingReturn: string | undefined,
  previousQueue: Map<string, PendingStopNotice>,
) => {
  ctx.followed.set(shareId, entry)
  if (observation) ctx.received.set(shareId, observation)
  if (pendingReturn) ctx.pendingReturns.set(shareId, pendingReturn)
  ctx.pendingStopNotices.clear()
  for (const [key, value] of previousQueue) ctx.pendingStopNotices.set(key, value)
}

const dispatchStoppedFollowing = (
  ctx: SharingContext,
  close: (() => Promise<boolean>) | undefined,
  pending: PendingStopNotice | undefined,
  eventId: string,
  shouldQueue: boolean,
) => {
  dispatchStopDelivery(
    () => (close ? close() : Promise.resolve(false)),
    async (sent) => {
      if (sent && pending && ctx.pendingStopNotices.delete(eventId)) {
        try {
          await ctx.persist()
        } catch {
          ctx.pendingStopNotices.set(eventId, pending)
        }
      }
      if (!sent && shouldQueue) {
        // The durable queue survives. The sweep retries after a short delay
        // instead of immediately attempting another slow dial.
        ctx.stopRetryAt = Math.max(ctx.stopRetryAt, Date.now() + 10_000)
      }
    },
  )
}

const createStopFollowing =
  (ctx: SharingContext): SharingRuntime['stopFollowing'] =>
  async (shareId) => {
    const comparison = ctx.comparisonRuns.get(shareId)
    if (comparison) {
      comparison.cancelled = true
      await comparison.close?.()
    }
    const close = ctx.viewerClosers.get(shareId)
    const entry = ctx.followed.get(shareId)
    if (!entry) return
    const observation = ctx.received.get(shareId)
    const pendingReturn = ctx.pendingReturns.get(shareId)
    const eventId = randomToken()
    const { shouldQueue, pending } = await preparePendingStop(ctx, entry, eventId)
    const previousQueue = queuePendingStop(ctx, pending)
    ctx.followed.delete(shareId)
    ctx.received.delete(shareId)
    ctx.pendingReturns.delete(shareId)
    try {
      if (shouldQueue || entry.saved) await ctx.persist()
    } catch (error) {
      restoreFollowingState(ctx, shareId, entry, observation, pendingReturn, previousQueue)
      throw error
    }
    ctx.viewerClosers.delete(shareId)
    ctx.returnSenders.delete(shareId)
    dispatchStoppedFollowing(
      ctx,
      close ? () => close(true, eventId) : undefined,
      pending,
      eventId,
      shouldQueue,
    )
    ctx.publish({
      message: shouldQueue
        ? 'Stopped following. The sender will be notified when reachable.'
        : 'Stopped following locally.',
    })
  }

const createSaveFollowing =
  (ctx: SharingContext): SharingRuntime['saveFollowing'] =>
  async (shareId, localName) => {
    const entry = ctx.followed.get(shareId)
    if (!entry) throw new Error('This location is no longer available.')
    if (!ctx.store || !ctx.privateStateAvailable) {
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
      await ctx.persist(true)
    } catch (error) {
      entry.localName = previousName
      entry.usesPrivateName = previousUsesPrivateName
      entry.saved = wasSaved
      throw error
    }
    ctx.publish()
  }

const scheduleTracePersist = (ctx: SharingContext): void => {
  if (
    !ctx.store ||
    !ctx.privateStateAvailable ||
    ctx.runtimeClosed ||
    ctx.traceSaveTimer !== undefined
  )
    return
  const delay = Math.max(0, 30_000 - (Date.now() - ctx.lastTraceSavedAt))
  ctx.traceSaveTimer = window.setTimeout(() => {
    ctx.traceSaveTimer = undefined
    ctx.lastTraceSavedAt = Date.now()
    void ctx.persist().catch(() => ctx.publish({ message: 'Received history could not be saved.' }))
  }, delay)
}

const createSetFollowTraceEnabled =
  (ctx: SharingContext): SharingRuntime['setFollowTraceEnabled'] =>
  async (shareId, enabled) => {
    await ctx.prepareState()
    const entry = ctx.followed.get(shareId)
    if (!entry || !entry.saved)
      throw new Error('Save this subscription before recording its history.')
    if (!ctx.store || !ctx.privateStateAvailable)
      throw new Error('Protected storage is unavailable.')
    if (entry.traceEnabled === enabled) return
    const previous = { traceEnabled: entry.traceEnabled, trace: entry.trace }
    entry.traceEnabled = enabled
    entry.trace = []
    try {
      await ctx.persist()
    } catch (error) {
      Object.assign(entry, previous)
      throw error
    }
    ctx.publish()
  }

const createClearFollowTrace =
  (ctx: SharingContext): SharingRuntime['clearFollowTrace'] =>
  async (shareId) => {
    await ctx.prepareState()
    const entry = ctx.followed.get(shareId)
    if (!entry) return
    const previous = entry.trace
    entry.trace = []
    try {
      await ctx.persist()
    } catch (error) {
      entry.trace = previous
      throw error
    }
    ctx.publish()
  }

const createSetFollowName =
  (ctx: SharingContext): SharingRuntime['setFollowName'] =>
  (shareId, name) => {
    const entry = ctx.followed.get(shareId)
    if (!entry) return
    entry.usesPrivateName = Boolean(name.trim())
    entry.localName = name.trim().slice(0, 32) || entry.sourceName || generatedFollowName(shareId)
    if (entry.peerId && ctx.namePreference(entry.peerId).associateNames) {
      ctx.peerNamePreferences.set(entry.peerId, {
        ...ctx.namePreference(entry.peerId),
        nickname: name.trim().slice(0, 32),
      })
    }
    if (entry.saved)
      void ctx.persist().catch(() => ctx.publish({ message: 'Nickname could not be saved.' }))
    ctx.publish()
  }

const createSetFollowColor =
  (ctx: SharingContext): SharingRuntime['setFollowColor'] =>
  (shareId, color) => {
    if (!FOLLOW_COLORS.includes(color as (typeof FOLLOW_COLORS)[number])) return
    const entry = ctx.followed.get(shareId)
    if (!entry) return
    for (const candidate of ctx.followed.values()) {
      if (candidate.sourcePeerId === entry.sourcePeerId) candidate.color = color
    }
    if (entry.saved)
      void ctx.persist().catch(() => ctx.publish({ message: 'Color could not be saved.' }))
    ctx.publish()
  }
