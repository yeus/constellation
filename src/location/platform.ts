import type {
  BrowserGeolocation,
  BrowserPosition,
  BrowserPositionError,
} from "./browser.ts";

type PermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "prompt-with-rationale";

interface TauriGeolocationApi {
  readonly checkPermissions: () => Promise<{ readonly location: PermissionState }>;
  readonly requestPermissions: (
    permissions: ["location"],
  ) => Promise<{ readonly location: PermissionState }>;
  readonly watchPosition: (
    options: {
      readonly enableHighAccuracy: boolean;
      readonly timeout: number;
      readonly maximumAge: number;
    },
    observer: (position: BrowserPosition | null, error?: string) => void,
  ) => Promise<number>;
  readonly clearWatch: (watchId: number) => Promise<void>;
}

const deniedError = (): BrowserPositionError & Error =>
  Object.assign(new Error("Location permission denied."), { code: 1 });

export const createTauriGeolocationAdapter = (
  loadApi: () => Promise<TauriGeolocationApi>,
): BrowserGeolocation => ({
  watchPosition: async (success, error, options = {}) => {
    const api = await loadApi();
    let permissions = await api.checkPermissions();
    if (
      permissions.location === "prompt" ||
      permissions.location === "prompt-with-rationale"
    ) {
      permissions = await api.requestPermissions(["location"]);
    }
    if (permissions.location !== "granted") {
      const denied = deniedError();
      error?.(denied);
      throw denied;
    }
    return api.watchPosition({
      enableHighAccuracy: options.enableHighAccuracy ?? true,
      timeout: options.timeout ?? 15_000,
      maximumAge: options.maximumAge ?? 0,
    }, (position, positionError) => {
      if (position) success(position);
      else if (positionError) error?.({ code: 2 });
    });
  },
  clearWatch: async (watchId) => {
    const api = await loadApi();
    await api.clearWatch(watchId);
  },
});

export const createPlatformGeolocation = (
  browserGeolocation: BrowserGeolocation | undefined,
  tauri = "__TAURI_INTERNALS__" in window,
): BrowserGeolocation | undefined =>
  tauri
    ? createTauriGeolocationAdapter(
        () => import("@tauri-apps/plugin-geolocation"),
      )
    : browserGeolocation;
