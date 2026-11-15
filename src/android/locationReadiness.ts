import type { SharingBehavior } from '../sharing/sharingBehavior.ts'
import type { AndroidSharingSetup } from './backgroundSharing.ts'

type Permissions = AndroidSharingSetup['permissions']

/** Device Location is a transient availability switch, not permission to edit a saved policy. */
export const canConfigureBackgroundSharing = (permissions: Permissions | undefined): boolean =>
  Boolean(permissions?.location && permissions.background && permissions.notifications)

export const canStartBackgroundShare = (permissions: Permissions | undefined): boolean =>
  canConfigureBackgroundSharing(permissions) && permissions?.servicesEnabled === true

/** Desired settings remain independent of the OS-permitted execution mode. */
export const effectiveSharingBehavior = (
  desired: SharingBehavior,
  isAndroid: boolean,
  permissions: Permissions | undefined,
): SharingBehavior => ({
  ...desired,
  publication:
    desired.publication === 'background' && (!isAndroid || !canStartBackgroundShare(permissions))
      ? 'foreground'
      : desired.publication,
})

export const sharingFallbackNotice = (
  desired: SharingBehavior,
  isAndroid: boolean,
  permissions: Permissions | undefined,
): string | undefined => {
  if (desired.publication !== 'background') return undefined
  if (!isAndroid)
    return 'Background location is available only in the Android app. Effective fallback: share only while the app is open.'
  if (canStartBackgroundShare(permissions)) return undefined
  const missing = [
    !permissions?.location && 'Location permission',
    !permissions?.background && 'Allow all the time',
    !permissions?.notifications && 'notifications',
  ]
    .filter(Boolean)
    .join(', ')
  if (permissions?.servicesEnabled === false) {
    return `Background requested but unavailable${missing ? ` (missing ${missing})` : ''}. Effective fallback: no location updates until device Location is enabled; otherwise only while the app is open.`
  }
  return `Background requested but unavailable${missing ? ` (missing ${missing})` : ''}. Effective fallback: location sharing only while the app is open, if foreground Location is allowed.`
}

export const deviceLocationNotice = (servicesEnabled: boolean, shareCount: number): string => {
  if (servicesEnabled) return ''
  return shareCount > 0
    ? 'Location is off on this device. Your existing sharing links remain saved, but no new location updates can be sent. You can turn it on in Android Settings.'
    : 'Location is off on this device. You can still view shared locations and change settings. To share your location, turn it on in Android Settings.'
}
