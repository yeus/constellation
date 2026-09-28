import { Channel, invoke } from '@tauri-apps/api/core'

import type { BrowserGeolocation, BrowserPosition, BrowserPositionError } from './browser.ts'

export interface AndroidLocationPermission {
  readonly grant: 'fine' | 'coarse' | 'none'
  readonly servicesEnabled: boolean
}

type AndroidLocationEvent = { readonly position: BrowserPosition } | { readonly error: number }

export interface AndroidLocationApi {
  readonly permission: () => Promise<AndroidLocationPermission>
  readonly requestPermission: () => Promise<AndroidLocationPermission>
  readonly watch: (
    options: PositionOptions,
    observer: (event: AndroidLocationEvent) => void,
  ) => Promise<number>
  readonly clearWatch: (watchId: number) => Promise<void>
  readonly current: (options: PositionOptions) => Promise<BrowserPosition>
}

const locationError = (code: number, message: string): BrowserPositionError & Error =>
  Object.assign(new Error(message), { code })

export const createTauriAndroidLocationApi = (): AndroidLocationApi => ({
  permission: () => invoke('android_location_permission'),
  requestPermission: () => invoke('android_request_location_permission'),
  watch: async (options, observer) => {
    const channel = new Channel<AndroidLocationEvent>()
    channel.onmessage = observer
    const result = await invoke<{ watchId: number }>('android_start_location_watch', {
      options,
      channel,
    })
    return result.watchId
  },
  clearWatch: async (watchId) => {
    await invoke('android_stop_location_watch', { watchId })
  },
  current: (options) => invoke('android_current_location', { options }),
})

export const ensureAndroidLocationPermission = async (
  api: AndroidLocationApi,
): Promise<AndroidLocationPermission> => {
  let permission = await api.permission()
  if (!permission.servicesEnabled) throw locationError(4, 'Device location services are disabled.')
  if (permission.grant === 'none') {
    try {
      permission = await api.requestPermission()
    } catch (cause) {
      const current = await api.permission().catch(() => undefined)
      if (!current) throw cause
      if (!current.servicesEnabled) throw locationError(4, 'Device location services are disabled.')
      if (current.grant === 'none') throw locationError(1, 'Location permission denied.')
      throw cause
    }
  }
  if (!permission.servicesEnabled) throw locationError(4, 'Device location services are disabled.')
  if (permission.grant === 'none') throw locationError(1, 'Location permission denied.')
  return permission
}

const classifyAndroidFailure = async (api: AndroidLocationApi): Promise<BrowserPositionError> => {
  const permission = await api.permission().catch(() => undefined)
  if (permission && !permission.servicesEnabled) return { code: 4 }
  if (permission?.grant === 'none') return { code: 1 }
  return { code: 2 }
}

export const createAndroidGeolocationAdapter = (api: AndroidLocationApi): BrowserGeolocation => ({
  watchPosition: async (success, error, options = {}) => {
    await ensureAndroidLocationPermission(api)
    try {
      return await api.watch(
        {
          enableHighAccuracy: options.enableHighAccuracy ?? true,
          maximumAge: options.maximumAge ?? 0,
          timeout: options.timeout ?? 15_000,
        },
        (event) => {
          if ('position' in event) success(event.position)
          else error?.({ code: event.error })
        },
      )
    } catch {
      const failure = await classifyAndroidFailure(api)
      throw locationError(failure.code, 'Android location watch could not start.')
    }
  },
  clearWatch: api.clearWatch,
  getCurrentPosition: (success, error, options = {}) => {
    void ensureAndroidLocationPermission(api)
      .then(() => api.current(options))
      .then(success)
      .catch(async (failure: unknown) => {
        if (typeof failure === 'object' && failure !== null && 'code' in failure) {
          error?.({ code: Number(failure.code) })
        } else {
          error?.(await classifyAndroidFailure(api))
        }
      })
  },
})
