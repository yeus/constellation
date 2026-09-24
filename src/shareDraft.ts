export type LocationPrecision = 'approximate' | 'exact'
export type ShareDuration = '1h' | '8h' | 'until-revoked'
export type ViewerCapacity = 1 | 10 | 50 | 'unlimited'
export type SharePublication = 'foreground' | 'background'

export interface ShareDraft {
  readonly precision: LocationPrecision
  readonly duration: ShareDuration
  readonly viewerCapacity: ViewerCapacity
  readonly untilRevokedAcknowledged: boolean
  readonly name: string
  readonly publication: SharePublication
}

export const createShareDraft = (): ShareDraft => ({
  precision: 'approximate',
  duration: '1h',
  viewerCapacity: 1,
  untilRevokedAcknowledged: false,
  name: '',
  publication: 'foreground',
})

export const setPrecision = (draft: ShareDraft, precision: LocationPrecision): ShareDraft => ({
  ...draft,
  precision,
})

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
})

export const canCreateShare = (draft: ShareDraft): boolean =>
  draft.name.length <= 32 && (draft.duration !== 'until-revoked' || draft.untilRevokedAcknowledged)

export const shareExpiryFor = (draft: ShareDraft, now: number): number | null => {
  if (draft.duration === '1h') return now + 60 * 60 * 1_000
  if (draft.duration === '8h') return now + 8 * 60 * 60 * 1_000
  return null
}
