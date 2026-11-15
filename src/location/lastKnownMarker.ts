import type { MapLocation } from './mapModel.ts'

export const LAST_KNOWN_CLOCK_AFTER_MS = 2 * 60 * 60_000
const MINIMUM_AVATAR_OPACITY = 0.45

const ageText = (milliseconds: number): string => {
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''} ago`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''} ago`
}

export const markerAgePresentation = (
  location: Pick<MapLocation, 'isOwn' | 'state' | 'capturedAt' | 'expiresAt'>,
  now: number,
): { opacity: number; clockBadge: boolean; ageLabel?: string } => {
  if (
    location.isOwn ||
    location.capturedAt === undefined ||
    (location.state !== 'stale' && (location.expiresAt === undefined || now < location.expiresAt))
  )
    return { opacity: 1, clockBadge: false }
  const age = Math.max(0, now - location.capturedAt)
  return {
    opacity: Math.max(
      MINIMUM_AVATAR_OPACITY,
      1 - (1 - MINIMUM_AVATAR_OPACITY) * Math.min(1, age / LAST_KNOWN_CLOCK_AFTER_MS),
    ),
    clockBadge: age >= LAST_KNOWN_CLOCK_AFTER_MS,
    ageLabel: `Last known · ${ageText(age)}`,
  }
}
