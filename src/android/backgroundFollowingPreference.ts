/** WebView key exists only to migrate previous opt-outs to the native encrypted store. */
export const BACKGROUND_FOLLOWING_KEY = 'constellation.background-following-enabled'

export const readBackgroundFollowingPreference = (storage: Pick<Storage, 'getItem'>): boolean => {
  try {
    return storage.getItem(BACKGROUND_FOLLOWING_KEY) !== 'off'
  } catch {
    // Keep the documented opt-in-to-background-following default if WebView
    // storage is temporarily unavailable. Never infer the preference from service ownership.
    return true
  }
}

export const persistBackgroundFollowingPreference = (
  storage: Pick<Storage, 'setItem'>,
  enabled: boolean,
): boolean => {
  try {
    storage.setItem(BACKGROUND_FOLLOWING_KEY, enabled ? 'on' : 'off')
    return true
  } catch {
    return false
  }
}
/** Native Android storage is authoritative. A missing value is migrated exactly once. */
export const resolveNativeFollowingPreference = async (
  saved: boolean | null | undefined,
  legacy: () => boolean,
  persistNative: (enabled: boolean) => Promise<boolean | null | undefined>,
): Promise<boolean> => {
  if (typeof saved === 'boolean') return saved
  const desired = legacy()
  if ((await persistNative(desired)) !== desired) {
    throw new Error('Android could not confirm the saved background following preference.')
  }
  return desired
}
