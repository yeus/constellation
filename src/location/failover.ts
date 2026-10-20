import type { BrowserGeolocation, BrowserPosition, BrowserPositionError } from './browser.ts'

interface FailoverTimers {
  readonly setTimer?: (callback: () => void, delayMs: number) => number
  readonly clearTimer?: (timerId: number) => void
  readonly onFallback?: (reason: 'error' | 'timeout') => void
}

type TimerScheduler = (callback: () => void, delayMs: number) => number
type TimerClearer = (timerId: number) => void

interface WatchSession {
  readonly native: BrowserGeolocation
  readonly webview?: BrowserGeolocation
  readonly options?: PositionOptions
  readonly success: (position: BrowserPosition) => void
  readonly error?: (error: BrowserPositionError) => void
  readonly onFallback?: (reason: 'error' | 'timeout') => void
  readonly setTimer: TimerScheduler
  readonly clearTimer: TimerClearer
  active: boolean
  provider: BrowserGeolocation
  providerWatchId?: number
  firstFix: boolean
  fallbackAllowed: boolean
  timerId?: number
}

const stopProvider = async (
  session: WatchSession,
  candidate: BrowserGeolocation = session.provider,
): Promise<void> => {
  if (session.timerId !== undefined) session.clearTimer(session.timerId)
  session.timerId = undefined
  const startedId = session.providerWatchId
  session.providerWatchId = undefined
  if (startedId !== undefined) await candidate.clearWatch(startedId)
}

const report = (session: WatchSession, failure: BrowserPositionError): void => {
  if (session.active) session.error?.(failure)
}

const clearFallbackTimer = (session: WatchSession): void => {
  if (session.timerId !== undefined) session.clearTimer(session.timerId)
  session.timerId = undefined
}

const armFallbackTimer = (session: WatchSession, candidate: BrowserGeolocation): void => {
  if (candidate !== session.native || !session.fallbackAllowed || session.firstFix) return
  session.timerId = session.setTimer(() => {
    if (session.firstFix || !session.active || session.provider !== session.native) return
    if (!session.fallbackAllowed) return
    if (session.webview) switchToWebview(session, 'timeout')
    else report(session, { code: 3 })
  }, 20_000)
}

const acceptWatchId = (
  session: WatchSession,
  candidate: BrowserGeolocation,
  startedId: number,
): void => {
  if (!session.active || session.provider !== candidate) {
    void candidate.clearWatch(startedId)
    return
  }
  session.providerWatchId = startedId
  armFallbackTimer(session, candidate)
}

const handleStartFailure = (
  session: WatchSession,
  candidate: BrowserGeolocation,
  failure: unknown,
): void => {
  if (!session.active || session.provider !== candidate) return
  const code =
    typeof failure === 'object' && failure !== null && 'code' in failure
      ? Number(failure.code)
      : 2
  if (candidate === session.native && code !== 1 && code !== 4 && session.webview) {
    switchToWebview(session, 'error')
  } else {
    session.fallbackAllowed = false
    clearFallbackTimer(session)
    report(session, { code })
  }
}

const handleProviderFailure = (
  session: WatchSession,
  candidate: BrowserGeolocation,
  failure: BrowserPositionError,
): void => {
  if (!session.active || session.provider !== candidate) return
  if (
    candidate === session.native &&
    failure.code !== 1 &&
    failure.code !== 4 &&
    session.webview
  ) {
    switchToWebview(session, 'error')
  } else {
    session.fallbackAllowed = false
    clearFallbackTimer(session)
    report(session, failure)
  }
}

const startProvider = (session: WatchSession, candidate: BrowserGeolocation): void => {
  session.provider = candidate
  let started: number | Promise<number>
  try {
    started = candidate.watchPosition(
      (position) => {
        if (!session.active || session.provider !== candidate) return
        session.firstFix = true
        clearFallbackTimer(session)
        session.success(position)
      },
      (failure) => handleProviderFailure(session, candidate, failure),
      session.options,
    )
  } catch (failure) {
    handleStartFailure(session, candidate, failure)
    return
  }
  if (typeof started === 'number') acceptWatchId(session, candidate, started)
  else {
    void started
      .then((startedId) => acceptWatchId(session, candidate, startedId))
      .catch((failure: unknown) => handleStartFailure(session, candidate, failure))
  }
}

const switchToWebview = (session: WatchSession, reason: 'error' | 'timeout'): void => {
  if (!session.active || session.provider !== session.native || !session.webview) return
  session.onFallback?.(reason)
  const webview = session.webview
  session.provider = webview
  void stopProvider(session, session.native)
    .then(() => {
      if (session.active) startProvider(session, webview)
    })
    .catch(() => report(session, { code: 2 }))
}

const createWatchingSession = (
  native: BrowserGeolocation,
  webview: BrowserGeolocation | undefined,
  options: PositionOptions | undefined,
  success: (position: BrowserPosition) => void,
  error: ((error: BrowserPositionError) => void) | undefined,
  timers: FailoverTimers,
  setTimer: TimerScheduler,
  clearTimer: TimerClearer,
): { provider: () => BrowserGeolocation; stop: () => Promise<void> } => {
  const session: WatchSession = {
    native,
    webview,
    options,
    success,
    error,
    onFallback: timers.onFallback,
    setTimer,
    clearTimer,
    active: true,
    provider: native,
    firstFix: false,
    fallbackAllowed: true,
  }
  startProvider(session, native)
  return {
    provider: () => session.provider,
    stop: async () => {
      session.active = false
      await stopProvider(session)
    },
  }
}

interface FailoverWatchRegistry {
  nextId: number
  readonly watches: Map<
    number,
    { stop: () => Promise<void>; provider: () => BrowserGeolocation }
  >
  readonly native: BrowserGeolocation
  readonly webview?: BrowserGeolocation
  readonly timers: FailoverTimers
  readonly setTimer: TimerScheduler
  readonly clearTimer: TimerClearer
}

const startFailoverWatch = (
  registry: FailoverWatchRegistry,
  success: (position: BrowserPosition) => void,
  error?: (error: BrowserPositionError) => void,
  options?: PositionOptions,
): number => {
  const id = ++registry.nextId
  registry.watches.set(
    id,
    createWatchingSession(
      registry.native,
      registry.webview,
      options,
      success,
      error,
      registry.timers,
      registry.setTimer,
      registry.clearTimer,
    ),
  )
  return id
}

const currentFailoverProvider = (registry: FailoverWatchRegistry): BrowserGeolocation =>
  [...registry.watches.values()].at(-1)?.provider() ?? registry.native

export const createFailoverGeolocation = (
  native: BrowserGeolocation,
  webview: BrowserGeolocation | undefined,
  timers: FailoverTimers = {},
): BrowserGeolocation => {
  const setTimer =
    timers.setTimer ??
    ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number)
  const clearTimer = timers.clearTimer ?? ((id) => globalThis.clearTimeout(id))
  const registry: FailoverWatchRegistry = {
    nextId: 0,
    watches: new Map(),
    native,
    webview,
    timers,
    setTimer,
    clearTimer,
  }
  return {
    watchPosition: (success, error, options) =>
      startFailoverWatch(registry, success, error, options),
    clearWatch: async (id) => {
      const watch = registry.watches.get(id)
      registry.watches.delete(id)
      await watch?.stop()
    },
    getCurrentPosition: (success, error, options) => {
      currentFailoverProvider(registry).getCurrentPosition?.(success, error, options)
    },
  }
}
