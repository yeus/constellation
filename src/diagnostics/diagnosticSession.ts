import { createBrowserLocationSource, type BrowserPosition } from '../location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../sharing/sharingRuntime.ts'
import type { PrivateState } from '../sharing/privateStore.ts'

/** A disposable, synthetic source using the production sharing runtime and no durable storage. */
export const createDiagnosticSession = (shareBaseUrl: string) => {
  let positionTimer: ReturnType<typeof setInterval> | undefined
  const position = (): BrowserPosition => ({
    timestamp: Date.now(),
    coords: {
      latitude: 40,
      longitude: 20,
      accuracy: 12,
      altitude: null,
      heading: null,
      speed: null,
    },
  })
  const source = createBrowserLocationSource({
    sourceId: crypto.randomUUID(),
    geolocation: {
      watchPosition: (receive) => {
        receive(position())
        positionTimer = setInterval(() => receive(position()), 1_000)
        return 1
      },
      clearWatch: () => {
        clearInterval(positionTimer)
        positionTimer = undefined
      },
      getCurrentPosition: (receive) => receive(position()),
    },
  })
  let stored: PrivateState | undefined
  const runtime = createSharingRuntime(source, shareBaseUrl, {
    load: () => Promise.resolve(stored),
    save: (next) => {
      stored = next
      return Promise.resolve()
    },
  })
  let current: SharingRuntimeState
  const transports = new Set<string>()
  const unsubscribe = runtime.subscribe((state) => {
    current = state
    runtime.networkDiagnostics().connections.forEach((entry) => transports.add(entry.transport))
  })
  let closing: Promise<void> | undefined
  return {
    runtime,
    state: () => current,
    transports: () => [...transports],
    wait: (predicate: (state: SharingRuntimeState) => boolean, signal: AbortSignal) =>
      new Promise<SharingRuntimeState>((resolve, reject) => {
        let remove: () => void = () => undefined
        const abort = () => {
          signal.removeEventListener('abort', abort)
          remove()
          reject(new Error('Diagnostic cancelled.'))
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
        const observe = (state: SharingRuntimeState) => {
          if (!predicate(state)) return
          signal.removeEventListener('abort', abort)
          remove()
          resolve(state)
        }
        remove = runtime.subscribe(observe)
        if (signal.aborted) abort()
        else if (predicate(current)) {
          remove()
          signal.removeEventListener('abort', abort)
          resolve(current)
        }
      }),
    close: () => {
      if (!closing)
        closing = runtime.stop().finally(() => {
          unsubscribe()
          source.stop()
          clearInterval(positionTimer)
          stored = undefined
        })
      return closing
    },
  }
}
export type DiagnosticSession = ReturnType<typeof createDiagnosticSession>
