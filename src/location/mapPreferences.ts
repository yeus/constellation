import type { MapDeclutteringPreferences } from './mapPresentation.ts'

const STORAGE_KEY = 'constellation.map-decluttering'

export const DEFAULT_MAP_DECLUTTERING_PREFERENCES: MapDeclutteringPreferences = {
  enabled: true,
  groupMarkerCollisions: true,
  groupUncertaintyOverlap: true,
  uncertaintyOverlapThreshold: 0.9,
  markerCollisionDistancePx: 18,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validNumber = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export const loadMapDeclutteringPreferences = (
  storage: Pick<Storage, 'getItem'>,
): MapDeclutteringPreferences => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_MAP_DECLUTTERING_PREFERENCES }
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return { ...DEFAULT_MAP_DECLUTTERING_PREFERENCES }
    return {
      enabled:
        typeof value.enabled === 'boolean'
          ? value.enabled
          : DEFAULT_MAP_DECLUTTERING_PREFERENCES.enabled,
      groupMarkerCollisions:
        typeof value.groupMarkerCollisions === 'boolean'
          ? value.groupMarkerCollisions
          : DEFAULT_MAP_DECLUTTERING_PREFERENCES.groupMarkerCollisions,
      groupUncertaintyOverlap:
        typeof value.groupUncertaintyOverlap === 'boolean'
          ? value.groupUncertaintyOverlap
          : DEFAULT_MAP_DECLUTTERING_PREFERENCES.groupUncertaintyOverlap,
      uncertaintyOverlapThreshold: validNumber(value.uncertaintyOverlapThreshold, 0.5, 1)
        ? value.uncertaintyOverlapThreshold
        : DEFAULT_MAP_DECLUTTERING_PREFERENCES.uncertaintyOverlapThreshold,
      markerCollisionDistancePx: validNumber(value.markerCollisionDistancePx, 12, 48)
        ? value.markerCollisionDistancePx
        : DEFAULT_MAP_DECLUTTERING_PREFERENCES.markerCollisionDistancePx,
    }
  } catch {
    return { ...DEFAULT_MAP_DECLUTTERING_PREFERENCES }
  }
}

export const saveMapDeclutteringPreferences = (
  storage: Pick<Storage, 'setItem'>,
  preferences: MapDeclutteringPreferences,
): void => {
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}
