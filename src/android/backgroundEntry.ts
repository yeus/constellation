import { createBrowserLocationSource, type BrowserPosition } from '../location/browser.ts'
import type { ShareDraft } from '../shareDraft.ts'
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

type BackgroundCommand =
  | {
      readonly type: 'start'
      readonly request: {
        readonly precision: ShareDraft['precision']
        readonly viewerCapacity: ShareDraft['viewerCapacity']
        readonly expiresAt: number | null
        readonly shareBaseUrl: string
      }
    }
  | { readonly type: 'location'; readonly position: BrowserPosition }
  | { readonly type: 'location-error'; readonly code: number }
  | { readonly type: 'stop' }

const post = (value: unknown): void =>
  window.ConstellationNative?.postMessage(JSON.stringify(value))

const durationFor = (expiresAt: number | null): ShareDraft['duration'] => {
  if (expiresAt === null) return 'until-revoked'
  return expiresAt - Date.now() > 60 * 60 * 1_000 ? '8h' : '1h'
}

const draftFor = (
  request: Extract<BackgroundCommand, { type: 'start' }>['request'],
): ShareDraft => ({
  precision: request.precision,
  duration: durationFor(request.expiresAt),
  viewerCapacity: request.viewerCapacity,
  untilRevokedAcknowledged: request.expiresAt === null,
})

const start = (): void => {
  let positionObserver: ((position: BrowserPosition) => void) | undefined
  let errorObserver: ((error: { code: number }) => void) | undefined
  let runtime: ReturnType<typeof createSharingRuntime> | undefined
  let requestedExpiry: number | null = null

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
    },
  })
  const report = (state: SharingRuntimeState): void => {
    const share = state.shares[0]
    post({
      type: 'status',
      status: {
        state: share ? 'sharing' : state.peerStatus === 'error' ? 'error' : 'starting',
        ...(share ? { share: { ...share, expiresAt: requestedExpiry } } : {}),
        location: state.location,
        message: state.message,
      },
    })
  }

  window.__constellationBackgroundCommand = (encoded) => {
    const command = JSON.parse(encoded) as BackgroundCommand
    if (command.type === 'location') return positionObserver?.(command.position)
    if (command.type === 'location-error') return errorObserver?.({ code: command.code })
    if (command.type === 'stop') {
      void runtime?.stop().finally(() => post({ type: 'stopped' }))
      runtime = undefined
      return
    }
    if (runtime) return
    requestedExpiry = command.request.expiresAt
    if (requestedExpiry !== null && Date.now() >= requestedExpiry) {
      post({ type: 'expired' })
      return
    }
    runtime = createSharingRuntime(location, command.request.shareBaseUrl)
    runtime.subscribe(report)
    void runtime.createShare(draftFor(command.request), command.request.expiresAt).catch((error) =>
      post({
        type: 'status',
        status: {
          state: 'error',
          location: location.getState(),
          message: error instanceof Error ? error.message : 'P2P sharing failed.',
        },
      }),
    )
  }
  post({ type: 'ready' })
}

start()
