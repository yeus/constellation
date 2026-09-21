export type LocationPrecision = "approximate" | "exact";
export type ShareDuration = "1h" | "8h" | "until-revoked";
export type ViewerCapacity = 1 | 10 | 50 | "unlimited";

export interface ShareDraft {
  readonly precision: LocationPrecision;
  readonly duration: ShareDuration;
  readonly viewerCapacity: ViewerCapacity;
  readonly untilRevokedAcknowledged: boolean;
}

export const createShareDraft = (): ShareDraft => ({
  precision: "approximate",
  duration: "1h",
  viewerCapacity: 1,
  untilRevokedAcknowledged: false,
});

export const setPrecision = (
  draft: ShareDraft,
  precision: LocationPrecision,
): ShareDraft => ({ ...draft, precision });

export const setDuration = (
  draft: ShareDraft,
  duration: ShareDuration,
): ShareDraft => ({
  ...draft,
  duration,
  untilRevokedAcknowledged: false,
});

export const setViewerCapacity = (
  draft: ShareDraft,
  viewerCapacity: ViewerCapacity,
): ShareDraft => ({ ...draft, viewerCapacity });

export const acknowledgeUntilRevoked = (
  draft: ShareDraft,
  untilRevokedAcknowledged: boolean,
): ShareDraft => ({ ...draft, untilRevokedAcknowledged });

export const canCreateShare = (draft: ShareDraft): boolean =>
  draft.duration !== "until-revoked" || draft.untilRevokedAcknowledged;
