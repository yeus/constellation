import { SharingBehavior } from './sharingBehavior.ts'
import type {
  EndedSourceShare,
  OldShareSummary,
  ReturnOffer,
  SharingRuntime,
  SourceShare,
} from './sharingContracts.ts'
import { restoredEndedSourceShare, restoredSourceShare } from './sharingRestore.ts'

import {
  clearPeerHistory,
  hasEndedPeerShare,
  protectActivePeerHistory,
  restoreFailedPeerHistoryClear,
  type PeerHistoryProtection,
} from './peerHistory.ts'
export { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
import { DEVICE_COMPARISON_PROTOCOL, type ComparisonBudget } from './deviceComparison.ts'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import type { PrivateKey } from '@libp2p/interface'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

import { shareExpiryFor, type ShareDraft } from '../shareDraft.ts'
import { startPrivateBrowserPeer } from './browserPeer.ts'
import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'
import { PEER_NAMES_PROTOCOL } from './peerNames.ts'
import {
  createShareInvitation,
  parseShareInvitation,
  shareInvitationUrl,
  returnOwnerMessage,
  verifyReturnOwner,
  type ShareCapability,
} from './shareLink.ts'
import { backgroundSharePolicy } from './sharePolicy.ts'
import { constellationProtocolV2, SHARE_STREAM_PROTOCOL } from './shareProtocol.ts'
import { parsePrivateState, type PrivateState } from './privateStore.ts'
import { retainedEndNotifications } from './shareLifecycle.ts'

import type { SharingContext } from './sharingContext.ts'
import { capacityFor } from './sharingRuntimeHelpers.ts'

export const createSourceApi = (
  ctx: SharingContext,
): Pick<
  SharingRuntime,
  | 'signReturnOwnership'
  | 'replaceBackgroundShareOwner'
  | 'importSourceShares'
  | 'setSharingBehavior'
  | 'clearOldPeers'
  | 'dismissStoppedViewer'
  | 'offerReturnShare'
  | 'dismissReturnOffer'
  | 'approveReturnLink'
  | 'approveViewer'
  | 'markReturnPromptSeen'
  | 'createShare'
  | 'stopShare'
  | 'stopEndNotifications'
> => ({
  signReturnOwnership: createSignReturnOwnership(ctx),
  replaceBackgroundShareOwner: createReplaceBackgroundShareOwner(ctx),
  importSourceShares: createImportSourceShares(ctx),
  setSharingBehavior: createSetSharingBehavior(ctx),
  clearOldPeers: createClearOldPeers(ctx),
  dismissStoppedViewer: createDismissStoppedViewer(ctx),
  offerReturnShare: createOfferReturnShare(ctx),
  dismissReturnOffer: createDismissReturnOffer(ctx),
  approveReturnLink: createApproveReturnLink(ctx),
  approveViewer: createApproveViewer(ctx),
  markReturnPromptSeen: createMarkReturnPromptSeen(ctx),
  createShare: createCreateShare(ctx),
  stopShare: createStopShare(ctx),
  stopEndNotifications: createStopEndNotifications(ctx),
})

const createSignReturnOwnership =
  (ctx: SharingContext): SharingRuntime['signReturnOwnership'] =>
  async (shareId, sourcePeerId) => {
    await ctx.prepareState()
    if (!ctx.privateKey || !ctx.privateStateAvailable)
      throw new Error('Owner identity is unavailable.')
    if (!shareId || !sourcePeerId) throw new Error('Invalid return share identity.')
    return {
      ownerPeerId: peerIdFromPrivateKey(ctx.privateKey).toString(),
      ownerProof: bytesToBase64Url(
        await ctx.privateKey.sign(returnOwnerMessage(shareId, sourcePeerId)),
      ),
    }
  }

type OwnerHandoffBinding = Parameters<SharingRuntime['replaceBackgroundShareOwner']>[4]

const validateOwnerHandoff = (
  ctx: SharingContext,
  current: SourceShare,
  binding: OwnerHandoffBinding,
  ownerPeerId: string,
) => {
  if (binding.mode === 'recipient') {
    if (current.publication !== 'background' || current.capacity !== 1) {
      throw new Error('Return share is not available for ownership handoff.')
    }
    if (binding.recipientPeerId === ownerPeerId || !binding.recipientPeerId) {
      throw new Error('Return share must be bound to a different authenticated recipient.')
    }
    if (current.approvedPeerId || current.sessions.size > 0) {
      throw new Error('Return share is not available for ownership handoff.')
    }
    return
  }
  if (
    !ctx.privateKey ||
    current.capability.ownerPeerId !== peerIdFromPrivateKey(ctx.privateKey).toString()
  ) {
    throw new Error('Source share ownership was already replaced.')
  }
  if (current.sessions.size > 0) {
    throw new Error('Source share is not available for ownership handoff.')
  }
}

const isIdenticalOwnerHandoff = (
  current: SourceShare,
  ownerPeerId: string,
  ownerProof: string,
  binding: OwnerHandoffBinding,
) =>
  current.capability.ownerPeerId === ownerPeerId &&
  current.capability.ownerProof === ownerProof &&
  (binding.mode === 'source' || current.approvedPeerId === binding.recipientPeerId)

const buildOwnerHandoffShare = (
  current: SourceShare,
  capability: SourceShare['capability'],
  binding: OwnerHandoffBinding,
): SourceShare => ({
  ...current,
  ...(binding.mode === 'recipient' ? { approvedPeerId: binding.recipientPeerId } : {}),
  capability,
  url: shareInvitationUrl(capability, current.url),
})

const createReplaceBackgroundShareOwner =
  (ctx: SharingContext): SharingRuntime['replaceBackgroundShareOwner'] =>
  async (shareId, sourcePeerId, ownerPeerId, ownerProof, binding) => {
    await ctx.prepareState()
    const current = ctx.shares.get(shareId)
    if (!current || current.capability.sourcePeerId !== sourcePeerId) {
      throw new Error('Share is not available for ownership handoff.')
    }
    const capability = { ...current.capability, ownerPeerId, ownerProof }
    if (!(await verifyReturnOwner(capability, ownerPeerId))) {
      throw new Error('Invalid return ownership proof.')
    }
    if (isIdenticalOwnerHandoff(current, ownerPeerId, ownerProof, binding)) {
      ctx.publish()
      return ctx.state.shares.find((share) => share.shareId === shareId)!
    }
    validateOwnerHandoff(ctx, current, binding, ownerPeerId)
    ctx.shares.set(shareId, buildOwnerHandoffShare(current, capability, binding))
    try {
      await ctx.persist()
    } catch (error) {
      ctx.shares.set(shareId, current)
      throw error
    }
    ctx.publish()
    return ctx.state.shares.find((share) => share.shareId === shareId)!
  }

const parseImportedSourceShares = (ctx: SharingContext, incoming: PrivateState) => {
  const active: SourceShare[] = []
  const ends: EndedSourceShare[] = []
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
    } else active.push(restoredSourceShare({ ...record, sourcePrivateKey }, ctx.sharingBehavior))
  }
  ends.push(
    ...retainedEndNotifications(incoming.endedShares ?? []).map((record) =>
      restoredEndedSourceShare({
        ...record,
        sourcePrivateKey: record.sourcePrivateKey ?? incoming.privateKey,
      }),
    ),
  )
  return { active, ends, expiredHistory }
}

const validateImportedSourceIdentities = (active: SourceShare[], ends: EndedSourceShare[]) => {
  for (const share of [...active, ...ends]) {
    if (
      !share.sourcePrivateKey ||
      peerIdFromPrivateKey(share.sourcePrivateKey).toString() !== share.capability.sourcePeerId
    )
      throw new Error('The imported source identity does not match its link.')
  }
}

const insertImportedShareState = (
  ctx: SharingContext,
  incoming: PrivateState,
  active: SourceShare[],
  ends: EndedSourceShare[],
  expiredHistory: OldShareSummary[],
  owned: ReadonlySet<string>,
) => [
  ctx.insertImportedEntries(
    ctx.endedShares,
    ends
      .filter((share) => !ctx.shares.has(share.capability.shareId))
      .map((share) => [share.capability.shareId, share]),
  ),
  ctx.insertImportedEntries(
    ctx.shares,
    active
      .filter((share) => !ctx.endedShares.has(share.capability.shareId))
      .map((share) => [share.capability.shareId, share]),
  ),
  ctx.insertImportedEntries(
    ctx.viewerLabels,
    (incoming.viewerLabels ?? [])
      .filter((record) => owned.has(record.shareId))
      .map((record) => [`${record.shareId}:${record.fingerprint}`, record.name]),
  ),
  ctx.insertImportedEntries(
    ctx.peerNamePreferences,
    (incoming.peerNamePreferences ?? []).map((record) => [record.peerId, record]),
  ),
  ctx.insertImportedEntries(
    ctx.oldSharing,
    [...(incoming.oldSharing ?? []), ...expiredHistory].map((record) => [
      JSON.stringify([record.shareId, record.peerId ?? null]),
      record,
    ]),
  ),
]

const insertImportedRelationState = (
  ctx: SharingContext,
  incoming: PrivateState,
  owned: ReadonlySet<string>,
) => [
  ctx.insertImportedEntries(
    ctx.stoppedViewers,
    (incoming.stoppedViewers ?? []).map((record) => [
      ctx.stoppedViewerKey(record.shareId, record.peerId),
      record,
    ]),
  ),
  ctx.insertImportedEntries(
    ctx.returnOffers,
    (incoming.returnOffers ?? [])
      .filter((record) => owned.has(record.shareId))
      .map((record) => [`${record.shareId}:${record.viewerFingerprint}`, record]),
  ),
  ctx.insertImportedEntries(
    ctx.deviceComparisons,
    (incoming.deviceComparisons ?? [])
      .filter((record) => record.role === 'sender' && owned.has(record.shareId))
      .map((record) => [record.challenge, record]),
  ),
]

const applyImportedApprovals = (
  ctx: SharingContext,
  incoming: PrivateState,
  owned: ReadonlySet<string>,
) => {
  const approvals = (incoming.approvedReturnLinks ?? []).filter(
    (id) => owned.has(id) && !ctx.approvedReturnLinks.has(id),
  )
  approvals.forEach((id) => ctx.approvedReturnLinks.add(id))
  const budgets = (incoming.comparisonBudgets ?? []).filter(
    (record) =>
      owned.has(record.shareId) &&
      !ctx.comparisonBudgets.some(
        (current) => current.shareId === record.shareId && current.ownPeerId === record.ownPeerId,
      ),
  )
  ctx.comparisonBudgets.push(...budgets)
  return { approvals, budgets }
}

const rollbackImportedState = (
  ctx: SharingContext,
  rollback: (() => void)[],
  approvals: string[],
  budgets: ComparisonBudget[],
) => {
  rollback.forEach((undo) => undo())
  approvals.forEach((id) => ctx.approvedReturnLinks.delete(id))
  for (const budget of budgets) {
    const index = ctx.comparisonBudgets.indexOf(budget)
    if (index !== -1) ctx.comparisonBudgets.splice(index, 1)
  }
  ctx.publish()
}

const createImportSourceShares =
  (ctx: SharingContext): SharingRuntime['importSourceShares'] =>
  async (incoming) => {
    await ctx.prepareState()
    const { active, ends, expiredHistory } = parseImportedSourceShares(ctx, incoming)
    validateImportedSourceIdentities(active, ends)
    const owned = new Set([...active, ...ends].map((share) => share.capability.shareId))
    const rollback = [
      ...insertImportedShareState(ctx, incoming, active, ends, expiredHistory, owned),
      ...insertImportedRelationState(ctx, incoming, owned),
    ]
    const { approvals, budgets } = applyImportedApprovals(ctx, incoming, owned)
    try {
      parsePrivateState(ctx.snapshot())
      await ctx.persist()
    } catch (error) {
      rollbackImportedState(ctx, rollback, approvals, budgets)
      throw error
    }
    ctx.publish()
  }

const createSetSharingBehavior =
  (ctx: SharingContext): SharingRuntime['setSharingBehavior'] =>
  async (requested) => {
    await ctx.prepareState()
    if (ctx.pendingSharingBehavior) throw new Error('Wait for the previous settings update.')
    const next = SharingBehavior.parse(requested)
    ctx.pendingSharingBehavior = next
    try {
      await ctx.persist()
    } catch (error) {
      ctx.pendingSharingBehavior = undefined
      // Repair later queued snapshots containing the attempted policy without dropping events.
      await ctx.persist().catch(() => undefined)
      ctx.publish()
      throw error
    }
    ctx.sharingBehavior = next
    ctx.pendingSharingBehavior = undefined
    for (const share of ctx.shares.values()) {
      share.publication = next.publication
      Object.assign(share, backgroundSharePolicy(next.publication, next.battery, next.network))
    }
    if (next.publication === 'foreground' && !ctx.visible) {
      for (const share of ctx.shares.values()) share.latest = undefined
      ctx.locationSource.stop()
    } else if (ctx.shares.size && !ctx.paused) ctx.locationSource.start()
    ctx.publish()
  }

const protectedHistoryFor = (
  ctx: SharingContext,
  protection: PeerHistoryProtection,
): PeerHistoryProtection => {
  const own = protectActivePeerHistory(ctx.state.shares, ctx.state.following)
  return {
    peerIds: [
      ...new Set([
        ...protection.peerIds,
        ...own.peerIds,
        ...[...ctx.pendingViewerApprovals.values()].map((request) => request.peerId),
        ...[...ctx.returnOffers.values()].map((offer) => offer.ownerPeerId),
      ]),
    ],
    shareIds: [...new Set([...protection.shareIds, ...own.shareIds])],
  }
}

const applyHistoryClear = (ctx: SharingContext, protection: PeerHistoryProtection) => ({
  previous: {
    sharing: new Map(ctx.oldSharing),
    seeing: new Map(ctx.oldSeeing),
    stopped: new Map(ctx.stoppedViewers),
  },
  next: {
    sharing: clearPeerHistory(ctx.oldSharing, protection),
    seeing: clearPeerHistory(ctx.oldSeeing, protection),
    stopped: clearPeerHistory(ctx.stoppedViewers, protection),
  },
})

const applyHistoryRecords = (
  ctx: SharingContext,
  next: ReturnType<typeof applyHistoryClear>['next'],
) => {
  ctx.applyHistoryRecords(ctx.oldSharing, next.sharing)
  ctx.applyHistoryRecords(ctx.oldSeeing, next.seeing)
  ctx.applyHistoryRecords(ctx.stoppedViewers, next.stopped)
}

const rollbackHistoryClear = (
  ctx: SharingContext,
  previous: ReturnType<typeof applyHistoryClear>['previous'],
  next: ReturnType<typeof applyHistoryClear>['next'],
) => {
  ctx.applyHistoryRecords(
    ctx.oldSharing,
    restoreFailedPeerHistoryClear(ctx.oldSharing, previous.sharing, next.sharing),
  )
  ctx.applyHistoryRecords(
    ctx.oldSeeing,
    restoreFailedPeerHistoryClear(ctx.oldSeeing, previous.seeing, next.seeing),
  )
  ctx.applyHistoryRecords(
    ctx.stoppedViewers,
    restoreFailedPeerHistoryClear(ctx.stoppedViewers, previous.stopped, next.stopped),
  )
}

const createClearOldPeers =
  (ctx: SharingContext): SharingRuntime['clearOldPeers'] =>
  async (protection) => {
    await ctx.prepareState()
    const history = applyHistoryClear(ctx, protectedHistoryFor(ctx, protection))
    applyHistoryRecords(ctx, history.next)
    try {
      await ctx.persist()
    } catch (error) {
      rollbackHistoryClear(ctx, history.previous, history.next)
      await ctx.persist().catch(() => undefined)
      ctx.publish()
      throw error
    }
    ctx.publish({ message: 'Unused ended entries cleared. Pending notices are kept.' })
  }

const createDismissStoppedViewer =
  (ctx: SharingContext): SharingRuntime['dismissStoppedViewer'] =>
  async (shareId, peerId) => {
    await ctx.prepareState()
    const key = ctx.stoppedViewerKey(shareId, peerId)
    const current = ctx.stoppedViewers.get(key)
    if (!current || current.dismissed) return
    ctx.stoppedViewers.set(key, { ...current, dismissed: true })
    try {
      await ctx.persist()
    } catch (error) {
      ctx.stoppedViewers.set(key, current)
      throw error
    }
    ctx.publish()
  }

const prepareReturnOffer = async (ctx: SharingContext, followShareId: string, url: string) => {
  const follow = ctx.followed.get(followShareId)
  if (!follow || follow.terminal || hasEndedPeerShare(ctx.oldSeeing.values(), followShareId)) {
    throw new Error('This location is no longer followed.')
  }
  const capability = parseShareInvitation(url)
  const { node } = await ctx.ensurePeer()
  if (!(await verifyReturnOwner(capability, node.peerId.toString()))) {
    throw new Error('This return link cannot prove which viewer created it.')
  }
  const originalCapability = parseShareInvitation(follow.url)
  if (!originalCapability.ownerPeerId || !(await verifyReturnOwner(originalCapability))) {
    throw new Error('This location link cannot verify the original sharer identity.')
  }
  return { capability, originalCapability }
}

const bindReturnShare = async (
  ctx: SharingContext,
  capability: ReturnableShare['capability'],
  originalCapability: ReturnableShare['capability'],
  options: { externalBoundRecipientPeerId?: string },
) => {
  const returnShare = ctx.shares.get(capability.shareId)
  if (!returnShare) {
    if (options.externalBoundRecipientPeerId !== originalCapability.ownerPeerId) {
      throw new Error('The background return link is not bound to the original sharer.')
    }
    return
  }
  if (returnShare.capacity !== 1) {
    throw new Error('The return link is not a single-recipient share.')
  }
  if (returnShare.approvedPeerId && returnShare.approvedPeerId !== originalCapability.ownerPeerId) {
    throw new Error('The return link is already bound to another peer.')
  }
  const previousApprovedPeerId = returnShare.approvedPeerId
  returnShare.approvedPeerId = originalCapability.ownerPeerId
  try {
    await ctx.persist()
  } catch (error) {
    returnShare.approvedPeerId = previousApprovedPeerId
    throw error
  }
}

type ReturnableShare = { capability: ShareCapability }

const createOfferReturnShare =
  (ctx: SharingContext): SharingRuntime['offerReturnShare'] =>
  async (followShareId, url, options = {}) => {
    await ctx.prepareState()
    const { capability, originalCapability } = await prepareReturnOffer(ctx, followShareId, url)
    await bindReturnShare(ctx, capability, originalCapability, options)
    ctx.publish()
    const send = ctx.returnSenders.get(followShareId)
    if (send) {
      await send(url)
      return
    }
    ctx.pendingReturns.set(followShareId, url)
    try {
      await ctx.persist()
    } catch (error) {
      ctx.pendingReturns.delete(followShareId)
      throw error
    }
    ctx.publish({ message: 'Return link queued until the original sharer reconnects.' })
  }

const createDismissReturnOffer =
  (ctx: SharingContext): SharingRuntime['dismissReturnOffer'] =>
  async (shareId, fingerprint) => {
    const key = `${shareId}:${fingerprint}`
    const offer = ctx.returnOffers.get(key)
    if (!offer) return
    ctx.returnOffers.delete(key)
    try {
      await ctx.persist()
    } catch (error) {
      ctx.returnOffers.set(key, offer)
      throw error
    }
    ctx.publish()
  }

const createApproveReturnLink =
  (ctx: SharingContext): SharingRuntime['approveReturnLink'] =>
  async (shareId) => {
    await ctx.prepareState()
    if (!ctx.shares.has(shareId)) throw new Error('This share is no longer active.')
    const wasApproved = ctx.approvedReturnLinks.has(shareId)
    ctx.approvedReturnLinks.add(shareId)
    try {
      await ctx.persist()
    } catch (error) {
      if (!wasApproved) ctx.approvedReturnLinks.delete(shareId)
      throw error
    }
    ctx.publish({ message: 'Share-back permission saved. Waiting for location.' })
    // Receiving a return location is network-dependent. It must not delay or undo
    // the already-persisted permission decision.
    const pending = [...ctx.returnOffers.entries()].filter(([, offer]) => offer.shareId === shareId)
    void Promise.all(
      pending.map(async ([key, offer]) => {
        try {
          await ctx.acceptPendingReturn(key, offer)
        } catch {
          ctx.publish({
            message: 'Permission saved. A return location is still pending; retry when connected.',
          })
        }
      }),
    )
  }

const createApproveViewer =
  (ctx: SharingContext): SharingRuntime['approveViewer'] =>
  async (shareId, peerId) => {
    await ctx.prepareState()
    const share = ctx.shares.get(shareId)
    const key = ctx.viewerApprovalKey(shareId, peerId)
    if (!share || share.capacity !== 1) {
      throw new Error('This is not an active single-recipient share.')
    }
    if (!ctx.pendingViewerApprovals.has(key)) {
      throw new Error('This device is no longer waiting for approval.')
    }
    if (share.approvedPeerId && share.approvedPeerId !== peerId) {
      throw new Error('Another device is already approved for this share.')
    }
    const previousPeerId = share.approvedPeerId
    share.approvedPeerId = peerId
    try {
      await ctx.persist()
    } catch (error) {
      share.approvedPeerId = previousPeerId
      throw error
    }
    ctx.pendingViewerApprovals.delete(key)
    ctx.publish({ message: 'This device can now view your location.' })
  }

const createMarkReturnPromptSeen =
  (ctx: SharingContext): SharingRuntime['markReturnPromptSeen'] =>
  async (shareId) => {
    await ctx.prepareState()
    const entry = ctx.followed.get(shareId)
    if (!entry || entry.returnPromptSeen) return
    entry.returnPromptSeen = true
    await ctx.persist()
    ctx.publish()
  }

const buildSourceShare = (
  draft: ShareDraft,
  invitation: Awaited<ReturnType<typeof createShareInvitation>>,
  sourcePrivateKey: PrivateKey,
): SourceShare => ({
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
})

const registerSourceHandlers = async (
  ctx: SharingContext,
  share: SourceShare,
  node: BrowserLibp2pNode,
) => {
  const shareId = share.capability.shareId
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

const applyInitialShareLocation = (ctx: SharingContext, share: SourceShare) => {
  const currentLocation = ctx.locationSource.getState()
  if (
    (currentLocation.status === 'live' || currentLocation.status === 'delayed') &&
    currentLocation.observation.expiresAt > Date.now()
  ) {
    ctx.updateShareLocation(share, currentLocation.observation)
  }
}

const createCreateShare =
  (ctx: SharingContext): SharingRuntime['createShare'] =>
  async (draft, expiresAt = shareExpiryFor(draft, Date.now()), linkBaseUrl = ctx.shareBaseUrl) => {
    await ctx.prepareState()
    if (ctx.sharingBehavior) draft = { ...draft, ...ctx.sharingBehavior }
    ctx.publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
    const sourcePrivateKey = await generateKeyPair('Ed25519')
    const started = await startPrivateBrowserPeer(sourcePrivateKey)
    const invitation = await createShareInvitation({
      baseUrl: linkBaseUrl,
      sourcePeerId: started.node.peerId.toString(),
      addresses: started.addresses,
      expiresAt,
      ownerPrivateKey: ctx.privateKey,
    })
    const share = buildSourceShare(draft, invitation, sourcePrivateKey)
    ctx.shares.set(share.capability.shareId, share)
    try {
      await registerSourceHandlers(ctx, share, started.node)
      ctx.sourceStarts.set(share.capability.shareId, Promise.resolve(started))
    } catch (error) {
      ctx.shares.delete(share.capability.shareId)
      await started.node.stop()
      throw error
    }
    applyInitialShareLocation(ctx, share)
    try {
      await ctx.persist()
    } catch (error) {
      ctx.shares.delete(share.capability.shareId)
      await ctx.stopSourcePeer(share.capability.shareId)
      throw error
    }
    if (!ctx.paused && (ctx.visible || draft.publication === 'background'))
      ctx.locationSource.start()
    ctx.publish()
    return ctx.state.shares.find(({ shareId }) => shareId === share.capability.shareId)!
  }

const prepareShareRevocation = (ctx: SharingContext, share: SourceShare) => {
  const shareId = share.capability.shareId
  const oldRecord: OldShareSummary = {
    shareId,
    ...(share.name ? { name: share.name } : {}),
    reason: 'revoked',
    endedAt: Date.now(),
  }
  return {
    oldRecord,
    previousOldRecords: new Map(ctx.oldSharing),
    wasReturnLinkApproved: ctx.approvedReturnLinks.has(shareId),
    removedOffers: [...ctx.returnOffers.entries()].filter(([, offer]) => offer.shareId === shareId),
    previousEndNotifications: new Map(ctx.endedShares),
    previousPaused: ctx.paused,
  }
}

const applyShareRevocation = (
  ctx: SharingContext,
  share: SourceShare,
  oldRecord: OldShareSummary,
  removedOffers: [string, ReturnOffer][],
) => {
  const shareId = share.capability.shareId
  ctx.pendingRevocations.add(shareId)
  ctx.rememberEndNotification(share, 'revoked', oldRecord.endedAt)
  const prunedEndIds = ctx.pruneEndNotifications()
  ctx.shares.delete(shareId)
  ctx.rememberEndedShareHistory(
    { shareId, name: share.name, viewerPeerIds: share.viewerPeerIds },
    'revoked',
    oldRecord.endedAt,
  )
  ctx.approvedReturnLinks.delete(shareId)
  removedOffers.forEach(([key]) => ctx.returnOffers.delete(key))
  if (!ctx.shares.size) ctx.paused = false
  return prunedEndIds
}

const rollbackShareRevocation = (
  ctx: SharingContext,
  share: SourceShare,
  previous: ReturnType<typeof prepareShareRevocation>,
) => {
  const shareId = share.capability.shareId
  ctx.pendingRevocations.delete(shareId)
  ctx.shares.set(shareId, share)
  ctx.endedShares.clear()
  previous.previousEndNotifications.forEach((record, id) => ctx.endedShares.set(id, record))
  ctx.oldSharing.clear()
  previous.previousOldRecords.forEach((record, key) => ctx.oldSharing.set(key, record))
  ctx.paused = previous.previousPaused
  if (previous.wasReturnLinkApproved) ctx.approvedReturnLinks.add(shareId)
  previous.removedOffers.forEach(([key, offer]) => ctx.returnOffers.set(key, offer))
}

const closeRevokedShareSessions = async (
  ctx: SharingContext,
  share: SourceShare,
  prunedEndIds: string[],
) => {
  const shareId = share.capability.shareId
  for (const [key, request] of ctx.pendingViewerApprovals) {
    if (request.shareId === shareId) ctx.pendingViewerApprovals.delete(key)
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
  await Promise.all(prunedEndIds.map(ctx.stopSourcePeer))
  if (!ctx.shares.size) ctx.locationSource.stop()
}

const createStopShare =
  (ctx: SharingContext): SharingRuntime['stopShare'] =>
  async (shareId) => {
    const share = ctx.shares.get(shareId)
    if (!share) return
    const previous = prepareShareRevocation(ctx, share)
    const prunedEndIds = applyShareRevocation(
      ctx,
      share,
      previous.oldRecord,
      previous.removedOffers,
    )
    try {
      await ctx.persist()
      ctx.pendingRevocations.delete(shareId)
    } catch (error) {
      rollbackShareRevocation(ctx, share, previous)
      throw error
    }
    await closeRevokedShareSessions(ctx, share, prunedEndIds)
    ctx.publish()
  }

const createStopEndNotifications =
  (ctx: SharingContext): SharingRuntime['stopEndNotifications'] =>
  async () => {
    const previous = new Map(ctx.endedShares)
    ctx.endedShares.clear()
    try {
      await ctx.persist()
    } catch (error) {
      previous.forEach((record, id) => ctx.endedShares.set(id, record))
      throw error
    }
    await Promise.all([...previous.keys()].map(ctx.stopSourcePeer))
    ctx.publish()
  }
