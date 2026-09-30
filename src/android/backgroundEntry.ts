import { shouldSignalIdleAfterShareUpdate } from './backgroundRuntimePolicy.ts'
import { createBrowserLocationSource, type BrowserPosition } from '../location/browser.ts'
import type { ShareDraft } from '../shareDraft.ts'
import {
  parsePrivateStateJson,
  type PrivateState,
  type PrivateStateStore,
} from '../sharing/privateStore.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../sharing/sharingRuntime.ts'

interface NativeBridge {
  postMessage: (message: string) => void
}

declare global {
  interface Window {
    ConstellationNative?: NativeBridge
    __constellationBackgroundCommand?: (command: string) => void
  }
}

type CreateRequest = {
  readonly precision: ShareDraft['precision']
  readonly viewerCapacity: ShareDraft['viewerCapacity']
  readonly name: string
  readonly publication: ShareDraft['publication']
  readonly visible: boolean
  readonly expiresAt: number | null
  readonly shareBaseUrl: string
}

type BackgroundCommand =
  | { readonly type: 'create-share'; readonly requestId: string; readonly request: CreateRequest }
  | { readonly type: 'location'; readonly position: BrowserPosition }
  | { readonly type: 'location-refresh-result'; readonly position: BrowserPosition }
  | { readonly type: 'location-error'; readonly code: number }
  | { readonly type: 'stop-share'; readonly shareId: string }
  | { readonly type: 'stop-all' }
  | { readonly type: 'stop-foreground-only' }
  | { readonly type: 'set-visible'; readonly visible: boolean }
  | { readonly type: 'block-viewer'; readonly shareId: string; readonly fingerprint: string }
  | {
      readonly type: 'set-viewer-name'
      readonly shareId: string
      readonly fingerprint: string
      readonly name: string
    }
  | {
      readonly type: 'private-state-result'
      readonly requestId: string
      readonly state?: string | null
      readonly error?: string
    }

const post = (value: unknown): void =>
  window.ConstellationNative?.postMessage(JSON.stringify(value))

const durationFor = (expiresAt: number | null): ShareDraft['duration'] => {
  if (expiresAt === null) return 'until-revoked'
  return expiresAt - Date.now() > 60 * 60 * 1_000 ? '8h' : '1h'
}

const draftFor = (request: CreateRequest): ShareDraft => ({
  precision: request.precision,
  duration: durationFor(request.expiresAt),
  viewerCapacity: request.viewerCapacity,
  untilRevokedAcknowledged: request.expiresAt === null,
  name: request.name,
  publication: request.publication,
})

const start = (): void => {
  let positionObserver: ((position: BrowserPosition) => void) | undefined
  let refreshObserver: ((position: BrowserPosition) => void) | undefined
  let errorObserver: ((error: { code: number }) => void) | undefined
  let latestState: SharingRuntimeState | undefined
  let previousShareCount = 0
  let requestCounter = 0
  let commandQueue = Promise.resolve()
  const pendingStoreRequests = new Map<
    string,
    { resolve: (state: string | null | undefined) => void; reject: (error: Error) => void }
  >()

  const storeRequest = (action: 'load' | 'save', state?: PrivateState) =>
    new Promise<string | null | undefined>((resolve, reject) => {
      const requestId = `${Date.now()}-${++requestCounter}`
      pendingStoreRequests.set(requestId, { resolve, reject })
      post({
        type: 'private-state',
        action,
        requestId,
        ...(state ? { state: JSON.stringify(state) } : {}),
      })
    })

  const privateStore: PrivateStateStore = {
    load: async () => {
      const encoded = await storeRequest('load')
      return encoded ? parsePrivateStateJson(encoded) : undefined
    },
    save: async (state) => {
      await storeRequest('save', state)
    },
  }

  const location = createBrowserLocationSource({
    sourceId: crypto.randomUUID(),
    geolocation: {
      watchPosition: (success, error) => {
        positionObserver = success
        errorObserver = error
        post({ type: 'location-watch-start' })
        return 1
      },
      clearWatch: () => post({ type: 'location-watch-stop' }),
      getCurrentPosition: (success) => {
        refreshObserver = success
        post({ type: 'location-refresh' })
      },
    },
  })
  const runtime = createSharingRuntime(location, undefined, privateStore)
  runtime.setVisible(false, false)

  const report = (state: SharingRuntimeState): void => {
    const shareCount = state.shares.length
    const becameIdle = shouldSignalIdleAfterShareUpdate(previousShareCount, shareCount)
    previousShareCount = shareCount
    latestState = state
    post({
      type: 'status',
      status: {
        state: shareCount ? 'sharing' : state.peerStatus === 'error' ? 'error' : 'starting',
        peerStatus: state.peerStatus,
        diagnostics: runtime.networkDiagnostics(),
        shares: state.shares,
        returnOffers: state.returnOffers,
        location: state.location,
        message: state.message,
      },
    })
    if (becameIdle) post({ type: 'idle' })
  }

  const sendError = (error: unknown, fallback: string): void =>
    post({
      type: 'status',
      status: {
        state: 'error',
        shares: latestState?.shares ?? [],
        location: location.getState(),
        message: error instanceof Error ? error.message : fallback,
      },
    })

  const runCommand = async (command: BackgroundCommand): Promise<void> => {
    if (command.type === 'private-state-result') {
      const pending = pendingStoreRequests.get(command.requestId)
      if (!pending) return
      pendingStoreRequests.delete(command.requestId)
      if (command.error) pending.reject(new Error(command.error))
      else pending.resolve(command.state)
      return
    }
    if (command.type === 'location') return positionObserver?.(command.position)
    if (command.type === 'location-refresh-result') {
      refreshObserver?.(command.position)
      refreshObserver = undefined
      return
    }
    if (command.type === 'location-error') return errorObserver?.({ code: command.code })
    if (command.type === 'create-share') {
      try {
        runtime.setVisible(command.request.visible, command.request.visible)
        await runtime.createShare(
          draftFor(command.request),
          command.request.expiresAt,
          command.request.shareBaseUrl,
        )
        post({ type: 'create-complete', requestId: command.requestId })
      } catch (error) {
        sendError(error, 'P2P sharing failed.')
        post({ type: 'create-complete', requestId: command.requestId })
      }
      return
    }
    if (command.type === 'stop-share') {
      try {
        await runtime.stopShare(command.shareId)
      } catch (error) {
        sendError(error, 'Could not revoke this location link.')
      }
      return
    }
    if (command.type === 'stop-all') {
      try {
        const shares = latestState?.shares ?? []
        await Promise.all(shares.map(({ shareId }) => runtime.stopShare(shareId)))
      } catch (error) {
        sendError(error, 'Could not stop all location links.')
      }
      if (!latestState?.shares.length) post({ type: 'idle' })
      return
    }
    const pauseForegroundOnly = async (): Promise<void> => {
      if (latestState?.shares.some((share) => share.publication === 'background')) return
      await runtime.stop()
      post({ type: 'paused' })
    }
    if (command.type === 'stop-foreground-only') {
      runtime.setVisible(false, false)
      await pauseForegroundOnly()
      return
    }
    if (command.type === 'set-visible') {
      runtime.setVisible(command.visible, command.visible)
      if (!command.visible) await pauseForegroundOnly()
      return
    }
    if (command.type === 'block-viewer') {
      try {
        await runtime.blockViewer(command.shareId, command.fingerprint)
      } catch (error) {
        sendError(error, 'Could not block this device.')
      }
      return
    }
    try {
      await runtime.setViewerLabel(command.shareId, command.fingerprint, command.name)
    } catch (error) {
      sendError(error, 'Could not save this device name.')
    }
  }

  window.__constellationBackgroundCommand = (encoded) => {
    const command = JSON.parse(encoded) as BackgroundCommand
    if (
      command.type === 'private-state-result' ||
      command.type === 'location' ||
      command.type === 'location-refresh-result' ||
      command.type === 'location-error'
    ) {
      void runCommand(command)
      return
    }
    commandQueue = commandQueue
      .then(() => runCommand(command))
      .catch((error) => {
        sendError(error, 'The background sharing command failed.')
      })
  }

  runtime.subscribe(report)
  void runtime
    .initialize()
    .catch((error) => sendError(error, 'Could not restore protected sharing state.'))
    .finally(() => post({ type: 'ready' }))
}

start()
