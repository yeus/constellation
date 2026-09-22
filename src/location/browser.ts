import {
  LOCATION_PROFILE_V1,
  parseLocationObservationV1,
  type LocationObservationV1,
} from "./locationObservation.ts";

export interface BrowserPosition {
  readonly timestamp: number;
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number;
    readonly altitude: number | null;
    readonly heading: number | null;
    readonly speed: number | null;
  };
}

export interface BrowserPositionError {
  readonly code: number;
}

export interface BrowserGeolocation {
  watchPosition: (
    success: (position: BrowserPosition) => void,
    error?: (error: BrowserPositionError) => void,
    options?: PositionOptions,
  ) => number | Promise<number>;
  clearWatch: (watchId: number) => void | Promise<void>;
}

export type BrowserLocationState =
  | { readonly status: "permission-required" }
  | { readonly status: "acquiring" }
  | { readonly status: "live"; readonly observation: LocationObservationV1 }
  | { readonly status: "delayed"; readonly observation: LocationObservationV1 }
  | { readonly status: "stale"; readonly observation: LocationObservationV1 }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "error";
      readonly code: "position-unavailable" | "timeout" | "unknown";
    };

export interface BrowserLocationSource {
  subscribeState: (
    observer: (state: BrowserLocationState) => void,
  ) => () => void;
  subscribeObservation: (
    observer: (observation: LocationObservationV1) => void,
  ) => () => void;
  getState: () => BrowserLocationState;
  start: () => void;
  stop: () => void;
}

interface BrowserLocationSourceOptions {
  readonly sourceId: string;
  readonly geolocation: BrowserGeolocation | undefined;
  readonly now?: () => number;
  readonly liveWindowMs?: number;
  readonly observationTtlMs?: number;
  readonly positionOptions?: PositionOptions;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (timerId: number) => void;
}

const locationErrorCode = (
  code: number,
): "position-unavailable" | "timeout" | "unknown" => {
  if (code === 2) return "position-unavailable";
  if (code === 3) return "timeout";
  return "unknown";
};

const createSubscriptions = <T>() => {
  const observers = new Set<(value: T) => void>();
  return {
    emit: (value: T) => observers.forEach((observer) => observer(value)),
    subscribe: (observer: (value: T) => void) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
};

export const createBrowserLocationSource = (
  options: BrowserLocationSourceOptions,
): BrowserLocationSource => {
  const now = options.now ?? Date.now;
  const liveWindowMs = options.liveWindowMs ?? 15_000;
  const observationTtlMs = options.observationTtlMs ?? 60_000;
  const setTimer =
    options.setTimer ??
    ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((timerId) => window.clearTimeout(timerId));
  const positionOptions = options.positionOptions ?? {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15_000,
  };
  const stateSubscriptions = createSubscriptions<BrowserLocationState>();
  const observationSubscriptions = createSubscriptions<LocationObservationV1>();
  let state: BrowserLocationState = options.geolocation
    ? { status: "permission-required" }
    : { status: "unavailable" };
  let sequence = 0;
  let watchId: number | undefined;
  let watchGeneration = 0;
  let freshnessTimers: number[] = [];

  const emitState = (next: BrowserLocationState): void => {
    state = next;
    stateSubscriptions.emit(next);
  };
  const clearFreshnessTimers = (): void => {
    freshnessTimers.forEach(clearTimer);
    freshnessTimers = [];
  };
  const freshnessState = (
    observation: LocationObservationV1,
  ): BrowserLocationState => {
    const currentTime = now();
    if (currentTime >= observation.expiresAt)
      return { status: "stale", observation };
    if (currentTime >= observation.capturedAt + liveWindowMs) {
      return { status: "delayed", observation };
    }
    return { status: "live", observation };
  };
  const updateFreshness = (observation: LocationObservationV1): void => {
    if (
      state.status !== "live" &&
      state.status !== "delayed" &&
      state.status !== "stale" &&
      state.status !== "acquiring"
    ) {
      return;
    }
    emitState(freshnessState(observation));
  };
  const scheduleFreshness = (observation: LocationObservationV1): void => {
    clearFreshnessTimers();
    const transitions = [
      observation.capturedAt + liveWindowMs,
      observation.expiresAt,
    ]
      .map((at) => at - now())
      .filter((delayMs) => delayMs > 0);
    freshnessTimers = transitions.map((delayMs) =>
      setTimer(() => updateFreshness(observation), delayMs),
    );
  };
  const stopWatching = (): void => {
    watchGeneration += 1;
    if (watchId !== undefined) void options.geolocation?.clearWatch(watchId);
    watchId = undefined;
    clearFreshnessTimers();
  };
  const receivePosition = (position: BrowserPosition): void => {
    const capturedAt = Math.floor(position.timestamp);
    const observation = parseLocationObservationV1({
      profile: LOCATION_PROFILE_V1,
      sourceId: options.sourceId,
      precision: "exact",
      sequence: ++sequence,
      capturedAt,
      expiresAt: capturedAt + observationTtlMs,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: Math.max(1, position.coords.accuracy),
      ...(position.coords.altitude === null
        ? {}
        : { altitudeMeters: position.coords.altitude }),
      ...(position.coords.heading === null
        ? {}
        : { headingDegrees: position.coords.heading }),
      ...(position.coords.speed === null
        ? {}
        : { speedMps: position.coords.speed }),
    });
    observationSubscriptions.emit(observation);
    emitState(freshnessState(observation));
    scheduleFreshness(observation);
  };
  const receiveError = (error: BrowserPositionError): void => {
    if (error.code === 1) {
      stopWatching();
      emitState({ status: "denied" });
      return;
    }
    emitState({ status: "error", code: locationErrorCode(error.code) });
  };

  return {
    subscribeState: stateSubscriptions.subscribe,
    subscribeObservation: observationSubscriptions.subscribe,
    getState: () => state,
    start: () => {
      if (!options.geolocation || watchId !== undefined) return;
      const generation = ++watchGeneration;
      let errorReported = false;
      emitState({ status: "acquiring" });
      const reportError = (error: BrowserPositionError): void => {
        errorReported = true;
        receiveError(error);
      };
      try {
        const pendingWatch = options.geolocation.watchPosition(
          receivePosition,
          reportError,
          positionOptions,
        );
        if (typeof pendingWatch === "number") {
          watchId = pendingWatch;
          return;
        }
        void pendingWatch
          .then((startedWatchId) => {
            if (generation !== watchGeneration) {
              void options.geolocation?.clearWatch(startedWatchId);
              return;
            }
            watchId = startedWatchId;
          })
          .catch((error: unknown) => {
            if (generation !== watchGeneration || errorReported) return;
            receiveError(
              typeof error === "object" && error !== null && "code" in error
                ? { code: Number(error.code) }
                : { code: 0 },
            );
          });
      } catch (error) {
        if (errorReported) return;
        receiveError(
          typeof error === "object" && error !== null && "code" in error
            ? { code: Number(error.code) }
            : { code: 0 },
        );
      }
    },
    stop: () => {
      stopWatching();
      emitState(
        options.geolocation
          ? { status: "permission-required" }
          : { status: "unavailable" },
      );
    },
  };
};
