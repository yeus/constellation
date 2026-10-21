import type { NetworkDiagnostics, SharingRuntime } from './sharingContracts.ts'

export { suggestedPeerName as generatedFollowName } from '../identity/peerName.ts'

import { SHARE_STREAM_PROTOCOL } from './shareProtocol.ts'
import { classifyTransport } from './transport.ts'

import type { SharingContext } from './sharingContext.ts'

export const createLifecycleApi = (
  ctx: SharingContext,
): Pick<
  SharingRuntime,
  | 'setNetworkState'
  | 'networkDiagnostics'
  | 'initialize'
  | 'subscribe'
  | 'setVisible'
  | 'setPaused'
  | 'stop'
> => ({
  setNetworkState: createSetNetworkState(ctx),
  networkDiagnostics: createNetworkDiagnostics(ctx),
  initialize: createInitialize(ctx),
  subscribe: createSubscribe(ctx),
  setVisible: createSetVisible(ctx),
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
      (entry) => ctx.returnShareReceiver === 'local' && !entry.connected && !entry.terminal,
    )
    void Promise.allSettled(
      pending.map((entry) =>
        ctx.runtimeApi!.acceptShare(entry.url, { localName: entry.localName, saved: entry.saved }),
      ),
    )
  }

const createSubscribe =
  (ctx: SharingContext): SharingRuntime['subscribe'] =>
  (observer) => {
    ctx.observers.add(observer)
    observer(ctx.state)
    return () => ctx.observers.delete(observer)
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
  async () => {
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
