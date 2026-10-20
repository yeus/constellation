import {
  LOCATION_PROFILE_V1,
  parseLocationObservationV1,
  type LocationObservationV1,
} from './locationObservation.ts'

export interface BrowserPosition {
  readonly timestamp: number
  readonly coords: {
    readonly latitude: number
    readonly longitude: number
    readonly accuracy: number
    readonly altitude: number | null
    readonly heading: number | null
    readonly speed: number | null
  }
}

export interface BrowserPositionError {
  readonly code: number
}

export interface BrowserGeolocation {
  watchPosition: (
    success: (position: BrowserPosition) => void,
    error?: (error: BrowserPositionError) => void,
    options?: PositionOptions,
  ) => number | Promise<number>
  clearWatch: (watchId: number) => void | Promise<void>
  getCurrentPosition?: (
    success: (position: BrowserPosition) => void,
    error?: (error: BrowserPositionError) => void,
    options?: PositionOptions,
  ) => void
}

export type BrowserLocationState =
  | { readonly status: 'permission-required' }
  | { readonly status: 'acquiring' }
  | { readonly status: 'live'; readonly observation: LocationObservationV1 }
  | { readonly status: 'delayed'; readonly observation: LocationObservationV1 }
  | { readonly status: 'stale'; readonly observation: LocationObservationV1 }
  | { readonly status: 'denied' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'error'
      readonly code: 'position-unavailable' | 'timeout' | 'unknown'
    }

export interface BrowserLocationSource {
  subscribeState: (observer: (state: BrowserLocationState) => void) => () => void
  subscribeObservation: (observer: (observation: LocationObservationV1) => void) => () => void
  getState: () => BrowserLocationState
  start: () => void
  stop: () => void
  refresh: () => void
}

interface BrowserLocationSourceOptions {
  readonly sourceId: string
  readonly geolocation: BrowserGeolocation | undefined
  readonly now?: () => number
  readonly liveWindowMs?: number
  readonly observationTtlMs?: number
  readonly positionOptions?: PositionOptions
  readonly setTimer?: (callback: () => void, delayMs: number) => number
  readonly clearTimer?: (timerId: number) => void
}

const locationErrorCode = (code: number): 'position-unavailable' | 'timeout' | 'unknown' => {
  if (code === 2) return 'position-unavailable'
  if (code === 3) return 'timeout'
  return 'unknown'
}

const createSubscriptions = <T>() => {
  const observers = new Set<(value: T) => void>()
  return {
    emit: (value: T) => observers.forEach((observer) => observer(value)),
    subscribe: (observer: (value: T) => void) => {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    },
  }
}

interface LocationTiming {
  readonly now: () => number
  readonly liveWindowMs: number
  readonly observationTtlMs: number
  readonly positionOptions: PositionOptions
  readonly setTimer: (callback: () => void, delayMs: number) => number
  readonly clearTimer: (timerId: number) => void
}

const observationFromPosition = (
  sourceId: string,
  position: BrowserPosition,
  sequence: number,
  ttlMs: number,
): LocationObservationV1 => {
  const capturedAt = Math.floor(position.timestamp)
  return parseLocationObservationV1({
    profile: LOCATION_PROFILE_V1,
    sourceId,
    precision: 'exact',
    sequence,
    capturedAt,
    expiresAt: capturedAt + ttlMs,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Math.max(1, position.coords.accuracy),
    ...(position.coords.altitude === null ? {} : { altitudeMeters: position.coords.altitude }),
    ...(position.coords.heading === null ? {} : { headingDegrees: position.coords.heading }),
    ...(position.coords.speed === null ? {} : { speedMps: position.coords.speed }),
  })
}

const freshnessStateFor = (
  observation: LocationObservationV1,
  now: number,
  liveWindowMs: number,
): BrowserLocationState => {
  if (now >= observation.expiresAt) return { status: 'stale', observation }
  if (now >= observation.capturedAt + liveWindowMs) return { status: 'delayed', observation }
  return { status: 'live', observation }
}

interface LocationStateController {
  readonly subscribeState: (observer: (state: BrowserLocationState) => void) => () => void
  readonly subscribeObservation: (
    observer: (observation: LocationObservationV1) => void,
  ) => () => void
  readonly getState: () => BrowserLocationState
  readonly emitState: (next: BrowserLocationState) => void
  readonly freshnessState: (observation: LocationObservationV1) => BrowserLocationState
  readonly scheduleFreshness: (observation: LocationObservationV1) => void
  readonly receivePosition: (position: BrowserPosition) => void
}

interface Subscriptions<T> {
  readonly emit: (value: T) => void
  readonly subscribe: (observer: (value: T) => void) => () => void
}

interface LocationStateStore {
  state: BrowserLocationState
  sequence: number
  freshnessTimers: number[]
  readonly stateSubscriptions: Subscriptions<BrowserLocationState>
  readonly observationSubscriptions: Subscriptions<LocationObservationV1>
  readonly options: BrowserLocationSourceOptions
  readonly timing: LocationTiming
}

const emitLocationState = (store: LocationStateStore, next: BrowserLocationState): void => {
  store.state = next
  store.stateSubscriptions.emit(next)
}

const clearFreshnessTimers = (store: LocationStateStore): void => {
  store.freshnessTimers.forEach(store.timing.clearTimer)
  store.freshnessTimers = []
}

const updateFreshness = (
  store: LocationStateStore,
  observation: LocationObservationV1,
): void => {
  if (!['live', 'delayed', 'stale', 'acquiring'].includes(store.state.status)) return
  emitLocationState(
    store,
    freshnessStateFor(observation, store.timing.now(), store.timing.liveWindowMs),
  )
}

const scheduleFreshness = (
  store: LocationStateStore,
  observation: LocationObservationV1,
): void => {
  clearFreshnessTimers(store)
  const transitions = [observation.capturedAt + store.timing.liveWindowMs, observation.expiresAt]
    .map((at) => at - store.timing.now())
    .filter((delayMs) => delayMs > 0)
  store.freshnessTimers = transitions.map((delayMs) =>
    store.timing.setTimer(() => updateFreshness(store, observation), delayMs),
  )
}

const receiveLocationPosition = (
  store: LocationStateStore,
  position: BrowserPosition,
): void => {
  const observation = observationFromPosition(
    store.options.sourceId,
    position,
    ++store.sequence,
    store.timing.observationTtlMs,
  )
  store.observationSubscriptions.emit(observation)
  emitLocationState(
    store,
    freshnessStateFor(observation, store.timing.now(), store.timing.liveWindowMs),
  )
  scheduleFreshness(store, observation)
}

const createLocationStateController = (
  options: BrowserLocationSourceOptions,
  timing: LocationTiming,
): LocationStateController => {
  const store: LocationStateStore = {
    state: options.geolocation ? { status: 'permission-required' } : { status: 'unavailable' },
    sequence: 0,
    freshnessTimers: [],
    stateSubscriptions: createSubscriptions<BrowserLocationState>(),
    observationSubscriptions: createSubscriptions<LocationObservationV1>(),
    options,
    timing,
  }
  return {
    subscribeState: store.stateSubscriptions.subscribe,
    subscribeObservation: store.observationSubscriptions.subscribe,
    getState: () => store.state,
    emitState: (next) => emitLocationState(store, next),
    freshnessState: (observation) =>
      freshnessStateFor(observation, timing.now(), timing.liveWindowMs),
    scheduleFreshness: (observation) => scheduleFreshness(store, observation),
    receivePosition: (position) => receiveLocationPosition(store, position),
  }
}

interface WatchStore {
  readonly options: BrowserLocationSourceOptions
  readonly timing: LocationTiming
  readonly state: LocationStateController
  watchId?: number
  watchStarting: boolean
  watchGeneration: number
  lastRefreshRequestedAt: number
}

const stopWatching = (store: WatchStore): void => {
  store.watchGeneration += 1
  store.watchStarting = false
  if (store.watchId !== undefined) void store.options.geolocation?.clearWatch(store.watchId)
  store.watchId = undefined
}

const receiveWatchError = (
  store: WatchStore,
  error: BrowserPositionError,
): void => {
  if (error.code === 1) {
    stopWatching(store)
    store.state.emitState({ status: 'denied' })
    return
  }
  store.state.emitState({ status: 'error', code: locationErrorCode(error.code) })
}

const acceptWatchId = (
  store: WatchStore,
  generation: number,
  startedWatchId: number,
): void => {
  if (generation !== store.watchGeneration) {
    void store.options.geolocation?.clearWatch(startedWatchId)
    return
  }
  store.watchStarting = false
  store.watchId = startedWatchId
}

const reportStartError = (
  store: WatchStore,
  generation: number,
  error: unknown,
  errorReported: boolean,
): void => {
  if (generation !== store.watchGeneration) return
  store.watchStarting = false
  if (errorReported) return
  receiveWatchError(
    store,
    typeof error === 'object' && error !== null && 'code' in error
      ? { code: Number(error.code) }
      : { code: 0 },
  )
}

const startWatching = (store: WatchStore): void => {
  if (!store.options.geolocation || store.watchId !== undefined || store.watchStarting) return
  const generation = ++store.watchGeneration
  store.watchStarting = true
  let errorReported = false
  store.state.emitState({ status: 'acquiring' })
  const reportError = (error: BrowserPositionError): void => {
    errorReported = true
    receiveWatchError(store, error)
  }
  try {
    const pendingWatch = store.options.geolocation.watchPosition(
      store.state.receivePosition,
      reportError,
      store.timing.positionOptions,
    )
    if (typeof pendingWatch === 'number') acceptWatchId(store, generation, pendingWatch)
    else {
      void pendingWatch
        .then((startedWatchId) => acceptWatchId(store, generation, startedWatchId))
        .catch((error: unknown) => reportStartError(store, generation, error, errorReported))
    }
  } catch (error) {
    reportStartError(store, generation, error, errorReported)
  }
}

const stopWatchingAndReset = (store: WatchStore): void => {
  stopWatching(store)
  store.state.emitState(
    store.options.geolocation
      ? { status: 'permission-required' }
      : { status: 'unavailable' },
  )
}

const refreshPosition = (store: WatchStore): void => {
  if (store.watchId === undefined || !store.options.geolocation?.getCurrentPosition) return
  const current = store.state.getState()
  if ('observation' in current && store.timing.now() - current.observation.capturedAt < 30_000)
    return
  if (store.timing.now() - store.lastRefreshRequestedAt < 60_000) return
  store.lastRefreshRequestedAt = store.timing.now()
  try {
    store.options.geolocation.getCurrentPosition(store.state.receivePosition, () => undefined, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20_000,
    })
  } catch {
    // A one-shot refresh must not break an otherwise valid subscription.
  }
}

const createWatchController = (
  options: BrowserLocationSourceOptions,
  timing: LocationTiming,
  state: LocationStateController,
) => {
  const store: WatchStore = {
    options,
    timing,
    state,
    watchStarting: false,
    watchGeneration: 0,
    lastRefreshRequestedAt: -Infinity,
  }
  return {
    start: () => startWatching(store),
    stop: () => stopWatchingAndReset(store),
    refresh: () => refreshPosition(store),
  }
}

export const createBrowserLocationSource = (
  options: BrowserLocationSourceOptions,
): BrowserLocationSource => {
  const timing: LocationTiming = {
    now: options.now ?? Date.now,
    liveWindowMs: options.liveWindowMs ?? 15_000,
    observationTtlMs: options.observationTtlMs ?? 60_000,
    positionOptions: options.positionOptions ?? {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
    },
    setTimer: options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs)),
    clearTimer: options.clearTimer ?? ((timerId) => window.clearTimeout(timerId)),
  }
  const state = createLocationStateController(options, timing)
  const watch = createWatchController(options, timing, state)
  return {
    subscribeState: state.subscribeState,
    subscribeObservation: state.subscribeObservation,
    getState: state.getState,
    ...watch,
  }
}
