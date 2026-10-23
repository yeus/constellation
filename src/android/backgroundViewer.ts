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

export const viewerPrivateState = (stored: PrivateState): PrivateState => {
  if (stored.shares.length || (stored.endedShares?.length ?? 0) > 0) {
    throw new Error('Viewer ownership requires separate source-share storage.')
  }
  // Only the locally saved subscriptions may be restored by the unattended runtime.
  return {
    ...stored,
    followed: stored.followed,
  }
}

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
