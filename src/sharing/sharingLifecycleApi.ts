import type { NetworkDiagnostics, SharingRuntime } from './sharingContracts.ts'

export { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'
import { isDefaultMapCamera, MapCameraSchema } from '../map/mapCamera.ts'

import { SHARE_STREAM_PROTOCOLS } from './shareProtocol.ts'
import { classifyTransport } from './transport.ts'
import { restoreFollows } from './sharingHelpers.ts'

import type { SharingContext } from './sharingContext.ts'

export const createLifecycleApi = (
  ctx: SharingContext,
): Pick<
  SharingRuntime,
  | 'setNetworkState'
  | 'networkDiagnostics'
  | 'initialize'
  | 'setFollowingSuspended'
  | 'recoverBackgroundSources'
  | 'subscribe'
  | 'setVisible'
  | 'setMapCamera'
  | 'setPaused'
  | 'stop'
> => ({
  setNetworkState: createSetNetworkState(ctx),
  networkDiagnostics: createNetworkDiagnostics(ctx),
  initialize: createInitialize(ctx),
  recoverBackgroundSources: createRecoverBackgroundSources(ctx),
  setFollowingSuspended: createSetFollowingSuspended(ctx),
  subscribe: createSubscribe(ctx),
  setVisible: createSetVisible(ctx),
  setMapCamera: createSetMapCamera(ctx),
  setPaused: createSetPaused(ctx),
  stop: createStop(ctx),
})

const createSetNetworkState =
  (ctx: SharingContext): SharingRuntime['setNetworkState'] =>
  (restriction) => {
    if (restriction === ctx.networkRestriction) return
    ctx.networkRestriction = restriction
    ctx.publish()
  }

const createNetworkDiagnostics =
  (ctx: SharingContext): SharingRuntime['networkDiagnostics'] =>
  () => ({
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

const createSetFollowingSuspended =
  (ctx: SharingContext): SharingRuntime['setFollowingSuspended'] =>
  async (suspended) => {
    if (suspended) {
      if (ctx.followersSuspended) return
      // Set before first load so read-only Activity restoration never writes
      // cleaned-up state over the service's authoritative encrypted store.
      ctx.followersSuspended = true
      try {
        await ctx.prepareState()
        const closers = [...ctx.viewerClosers.values()]
        await Promise.allSettled(closers.map((close) => close(false)))
        for (const entry of ctx.followed.values()) entry.connected = false
      } catch (error) {
        ctx.followersSuspended = false
        throw error
      }
      await ctx.persistence
      ctx.publish()
      return
    }
    await ctx.prepareState()
    if (!ctx.followersSuspended) return
    // The native owner has released its write fence. Reload its durable viewer
    // state before any foreground dial or persistence can occur.
    if (ctx.returnShareReceiver === 'local' && ctx.store) {
      const stored = await ctx.store.load()
      if (!stored || stored.privateKey !== ctx.snapshot().privateKey) {
        throw new Error('Protected receiver identity changed; following remains suspended.')
      }
      ctx.followed.clear()
      ctx.received.clear()
      await restoreFollows(ctx, stored)
    }
    ctx.followersSuspended = false
    await Promise.allSettled(
      [...ctx.followed.values()]
        .filter((entry) => entry.saved && !entry.terminal && !entry.approvalDenied)
        .map((entry) =>
          ctx.runtimeApi!.acceptShare(entry.url, {
            localName: entry.localName,
            saved: true,
          }),
        ),
    )
    ctx.publish()
  }

const createInitialize =
  (ctx: SharingContext): SharingRuntime['initialize'] =>
  async () => {
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
        (ctx.visible ||
          [...ctx.shares.values()].some((share) => share.publication === 'background'))
      ) {
        ctx.locationSource.start()
      }
    }
    const pending = [...ctx.followed.values()].filter(
      (entry) =>
        ctx.returnShareReceiver === 'local' &&
        !ctx.followersSuspended &&
        !entry.connected &&
        !entry.terminal &&
        !entry.approvalDenied,
    )
    void Promise.allSettled(
      pending.map((entry) =>
        ctx.runtimeApi!.acceptShare(entry.url, { localName: entry.localName, saved: entry.saved }),
      ),
    )
  }

const createRecoverBackgroundSources = (
  ctx: SharingContext,
): SharingRuntime['recoverBackgroundSources'] => {
  let pending: Promise<void> | undefined
  return () => {
    if (pending) return pending
    pending = (async () => {
      await ctx.prepareState()
      const sources = [...ctx.shares.values()].filter(
        (share) => share.publication === 'background' && Boolean(share.sourcePrivateKey),
      )
      for (const share of sources) {
        const shareId = share.capability.shareId
        if (ctx.runtimeClosed || ctx.shares.get(shareId) !== share) continue
        await ctx.stopSourcePeer(shareId)
        if (ctx.runtimeClosed || ctx.shares.get(shareId) !== share) continue
        await ctx.startSourcePeer(share)
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
}

const createSubscribe =
  (ctx: SharingContext): SharingRuntime['subscribe'] =>
  (observer) => {
    ctx.observers.add(observer)
    observer(ctx.state)
    return () => ctx.observers.delete(observer)
  }

const createSetMapCamera =
  (ctx: SharingContext): SharingRuntime['setMapCamera'] =>
  (input) => {
    if (!ctx.store || !ctx.privateStateAvailable || !ctx.state.privateStateReady) return
    const parsed = MapCameraSchema.safeParse(input)
    if (!parsed.success) return
    const camera = parsed.data
    if (!ctx.mapCamera && isDefaultMapCamera(camera)) return
    if (
      ctx.mapCamera &&
      ctx.mapCamera.longitude === camera.longitude &&
      ctx.mapCamera.latitude === camera.latitude &&
      ctx.mapCamera.zoom === camera.zoom
    )
      return
    ctx.mapCamera = camera
    ctx.state = { ...ctx.state, mapCamera: camera }
    if (ctx.mapCameraSaveTimer !== undefined) window.clearTimeout(ctx.mapCameraSaveTimer)
    ctx.mapCameraSaveTimer = window.setTimeout(() => {
      ctx.mapCameraSaveTimer = undefined
      void ctx.persist().catch(() => undefined)
    }, 1500)
  }

const createSetVisible =
  (ctx: SharingContext): SharingRuntime['setVisible'] =>
  (nextVisible, acquireLocation = true) => {
    ctx.visible = nextVisible
    if (ctx.visible) {
      if (acquireLocation || ctx.shares.size > 0) ctx.locationSource.start()
    } else {
      for (const share of ctx.shares.values()) {
        if (share.publication === 'foreground') share.latest = undefined
      }
      if (ctx.traceSaveTimer !== undefined) {
        window.clearTimeout(ctx.traceSaveTimer)
        ctx.traceSaveTimer = undefined
        void ctx
          .persist()
          .catch(() => ctx.publish({ message: 'Received history could not be saved.' }))
      }
      if (![...ctx.shares.values()].some((share) => share.publication === 'background')) {
        ctx.locationSource.stop()
      }
    }
    ctx.publish()
  }

const createSetPaused =
  (ctx: SharingContext): SharingRuntime['setPaused'] =>
  async (nextPaused) => {
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

const createStop =
  (ctx: SharingContext): SharingRuntime['stop'] =>
  async (options) => {
    ctx.runtimeClosed = true
    for (const run of ctx.comparisonRuns.values()) {
      run.cancelled = true
      await run.close?.()
    }
    window.clearInterval(ctx.heartbeatSweep)
    if (ctx.noticeTimer !== undefined) window.clearTimeout(ctx.noticeTimer)
    if (ctx.mapCameraSaveTimer !== undefined) {
      window.clearTimeout(ctx.mapCameraSaveTimer)
      ctx.mapCameraSaveTimer = undefined
      await ctx.persist().catch(() => undefined)
    }
    if (ctx.traceSaveTimer !== undefined) {
      window.clearTimeout(ctx.traceSaveTimer)
      ctx.traceSaveTimer = undefined
      await ctx.persist().catch(() => undefined)
    }
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
      await ctx.handlerNode.unhandle([...SHARE_STREAM_PROTOCOLS])
      await ctx.handlerNode.stop()
    }
    // Native handoff requires a fresh committed snapshot and a fully flushed
    // persistence queue before releasing the service writer fence.
    if (options?.requireDurableState) await ctx.persist()
    ctx.shares.clear()
    ctx.received.clear()
    ctx.followed.clear()
    ctx.observers.clear()
  }
