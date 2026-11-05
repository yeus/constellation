import { createBrowserLocationSource } from '../location/browser.ts'
import {
  createSharingRuntime,
  type SharingRuntime,
  type SharingRuntimeState,
} from '../sharing/sharingRuntime.ts'
import type { PrivateState, PrivateStateStore } from '../sharing/privateStore.ts'

export interface BackgroundViewerSnapshot {
  readonly generation: number
  readonly following: readonly {
    readonly shareId: string
    readonly status: SharingRuntimeState['following'][number]['status']
    readonly connected: boolean
    readonly lastLocationAt?: number
    readonly updatesReceived: number
  }[]
  readonly received: SharingRuntimeState['received']
}

// The native ownership fence merges only these receiver-owned fields back
// into the full encrypted state. Never initialize outgoing shares in the
// unattended viewer, even when this device is also a location source.
export const viewerPrivateState = (stored: PrivateState): PrivateState => ({
  version: stored.version,
  privateKey: stored.privateKey,
  shares: [],
  followed: stored.followed,
  ...(stored.oldSeeing ? { oldSeeing: stored.oldSeeing } : {}),
  ...(stored.pendingStopNotices ? { pendingStopNotices: stored.pendingStopNotices } : {}),
  ...(stored.pendingReturns ? { pendingReturns: stored.pendingReturns } : {}),
})

export const backgroundViewerSnapshot = (
  generation: number,
  state: SharingRuntimeState,
): BackgroundViewerSnapshot => ({
  generation,
  following: state.following
    .filter(
      ({ saved, status }) =>
        saved && status !== 'expired' && status !== 'revoked' && status !== 'denied',
    )
    .map(({ shareId, status, connected, lastLocationAt, updatesReceived }) => ({
      shareId,
      status,
      connected,
      ...(lastLocationAt ? { lastLocationAt } : {}),
      updatesReceived,
    })),
  received: state.received.filter(({ shareId }) =>
    state.following.some(
      (entry) =>
        entry.saved &&
        entry.status !== 'expired' &&
        entry.status !== 'revoked' &&
        entry.status !== 'denied' &&
        entry.shareId === shareId,
    ),
  ),
})

export const createBackgroundViewer = (options: {
  readonly generation: number
  readonly store: PrivateStateStore
  readonly onState: (status: BackgroundViewerSnapshot) => void
}): { start: () => Promise<void>; stop: () => Promise<void>; runtime: SharingRuntime } => {
  const location = createBrowserLocationSource({
    sourceId: 'unattended-viewer-no-location-sensor',
    geolocation: undefined,
  })
  const restrictedStore: PrivateStateStore = {
    load: async () => {
      const stored = await options.store.load()
      if (!stored) throw new Error('A protected viewer identity is required.')
      return viewerPrivateState(stored)
    },
    save: async (state) => options.store.save(viewerPrivateState(state)),
  }
  const runtime = createSharingRuntime(location, undefined, restrictedStore, 'local')
  runtime.setVisible(false, false)
  const unsubscribe = runtime.subscribe((state) =>
    options.onState(backgroundViewerSnapshot(options.generation, state)),
  )
  return {
    runtime,
    start: () => runtime.initialize(),
    stop: async () => {
      unsubscribe()
      await runtime.stop({ requireDurableState: true })
    },
  }
}
