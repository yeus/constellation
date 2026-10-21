import { createBrowserLocationSource, type BrowserPosition } from '../location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../sharing/sharingRuntime.ts'
import type { PrivateState } from '../sharing/privateStore.ts'

const syntheticPosition = (): BrowserPosition => ({
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

const createSyntheticSource = () => {
  let positionTimer: ReturnType<typeof setInterval> | undefined
  const source = createBrowserLocationSource({
    sourceId: crypto.randomUUID(),
    geolocation: {
      watchPosition: (receive) => {
        receive(syntheticPosition())
        positionTimer = setInterval(() => receive(syntheticPosition()), 1_000)
        return 1
      },
      clearWatch: () => {
        clearInterval(positionTimer)
        positionTimer = undefined
      },
      getCurrentPosition: (receive) => receive(syntheticPosition()),
    },
  })
  return {
    source,
    stop: () => {
      source.stop()
      clearInterval(positionTimer)
      positionTimer = undefined
    },
  }
}

const createMemoryPrivateStore = () => {
  let stored: PrivateState | undefined
  return {
    load: () => Promise.resolve(stored),
    save: (next: PrivateState) => {
      stored = next
      return Promise.resolve()
    },
    clear: () => {
      stored = undefined
    },
  }
}

const waitForDiagnosticState = (
  runtime: ReturnType<typeof createSharingRuntime>,
  currentState: () => SharingRuntimeState,
  predicate: (state: SharingRuntimeState) => boolean,
  signal: AbortSignal,
): Promise<SharingRuntimeState> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Diagnostic cancelled.'))
      return
    }
    let remove: () => void = () => undefined
    const cleanup = () => {
      signal.removeEventListener('abort', abort)
      remove()
    }
    const abort = () => {
      cleanup()
      reject(new Error('Diagnostic cancelled.'))
    }
    const observe = (state: SharingRuntimeState) => {
      if (!predicate(state)) return
      cleanup()
      resolve(state)
    }
    signal.addEventListener('abort', abort, { once: true })
    remove = runtime.subscribe(observe)
    if (signal.aborted) abort()
    else if (predicate(currentState())) {
      cleanup()
      resolve(currentState())
    }
  })

const createSessionState = (runtime: ReturnType<typeof createSharingRuntime>) => {
  let current: SharingRuntimeState
  const transports = new Set<string>()
  const unsubscribe = runtime.subscribe((state) => {
    current = state
    runtime.networkDiagnostics().connections.forEach((entry) => transports.add(entry.transport))
  })
  return {
    runtime,
    state: () => current,
    transports: () => [...transports],
    unsubscribe,
  }
}

/** A disposable, synthetic source using the production sharing runtime and no durable storage. */
export const createDiagnosticSession = (shareBaseUrl: string) => {
  const synthetic = createSyntheticSource()
  const storage = createMemoryPrivateStore()
  const session = createSessionState(
    createSharingRuntime(synthetic.source, shareBaseUrl, {
      load: storage.load,
      save: storage.save,
    }),
  )
  let closing: Promise<void> | undefined
  return {
    runtime: session.runtime,
    state: session.state,
    transports: session.transports,
    wait: (predicate: (state: SharingRuntimeState) => boolean, signal: AbortSignal) =>
      waitForDiagnosticState(session.runtime, session.state, predicate, signal),
    close: () => {
      closing ??= session.runtime.stop().finally(() => {
        session.unsubscribe()
        synthetic.stop()
        storage.clear()
      })
      return closing
    },
  }
}
export type DiagnosticSession = ReturnType<typeof createDiagnosticSession>
