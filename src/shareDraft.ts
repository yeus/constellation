export type LocationPrecision = 'approximate' | 'very-coarse' | 'exact'
export type ShareDuration = '1h' | '8h' | 'until-revoked'
export type ViewerCapacity = 1 | 10 | 50 | 'unlimited'
export type SharePublication = 'foreground' | 'background'
export type ShareBatteryPolicy = 'balanced' | 'saver'
export type ShareNetworkPolicy = 'always' | 'pause-when-metered'
export type SharePauseReason = 'metered' | 'data-saver'
export const VERY_COARSE_RADIUS_METERS = 20_000

export interface ShareDraft {
  readonly precision: LocationPrecision
  readonly duration: ShareDuration
  readonly viewerCapacity: ViewerCapacity
  readonly untilRevokedAcknowledged: boolean
  readonly name: string
  readonly publication: SharePublication
  readonly battery: ShareBatteryPolicy
  readonly network: ShareNetworkPolicy
}

export const createShareDraft = (): ShareDraft => ({
  precision: 'approximate',
  duration: '1h',
  viewerCapacity: 1,
  untilRevokedAcknowledged: false,
  name: '',
  publication: 'foreground',
  battery: 'balanced',
  network: 'always',
})

export const setPrecision = (draft: ShareDraft, precision: LocationPrecision): ShareDraft => ({
  ...draft,
  precision,
})

export const disclosedPrecisionFor = (precision: LocationPrecision): 'approximate' | 'exact' =>
  precision === 'exact' ? 'exact' : 'approximate'

export const setDuration = (draft: ShareDraft, duration: ShareDuration): ShareDraft => ({
  ...draft,
  duration,
  untilRevokedAcknowledged: false,
})

export const setViewerCapacity = (
  draft: ShareDraft,
  viewerCapacity: ViewerCapacity,
): ShareDraft => ({ ...draft, viewerCapacity })

export const acknowledgeUntilRevoked = (
  draft: ShareDraft,
  untilRevokedAcknowledged: boolean,
): ShareDraft => ({ ...draft, untilRevokedAcknowledged })

export const setName = (draft: ShareDraft, name: string): ShareDraft => ({
  ...draft,
  name: name.trim(),
})

export const setPublication = (draft: ShareDraft, publication: SharePublication): ShareDraft => ({
  ...draft,
  publication,
  ...(publication === 'foreground'
    ? { battery: 'balanced' as const, network: 'always' as const }
    : {}),
})

export const setBatteryPolicy = (draft: ShareDraft, battery: ShareBatteryPolicy): ShareDraft => ({
  ...draft,
  battery,
})

export const setNetworkPolicy = (draft: ShareDraft, network: ShareNetworkPolicy): ShareDraft => ({
  ...draft,
  network,
})

export const canCreateShare = (draft: ShareDraft): boolean =>
  draft.name.length <= 32 && (draft.duration !== 'until-revoked' || draft.untilRevokedAcknowledged)

export const shareExpiryFor = (draft: ShareDraft, now: number): number | null => {
  if (draft.duration === '1h') return now + 60 * 60 * 1_000
  if (draft.duration === '8h') return now + 8 * 60 * 60 * 1_000
  return null
}
