import type { MapLocation } from './mapModel.ts'
import type { MapViewport, ProjectedMapLocation } from './mapPresentation.ts'
import { proximityScoreMeters } from './peerRanking.ts'

export interface GeographicCenter {
  readonly latitude: number
  readonly longitude: number
}

export const OFFSCREEN_RAIL_TOP_PX = 96
export const OFFSCREEN_RAIL_ITEM_PX = 42
export const OFFSCREEN_RAIL_GAP_PX = 7.2
const OFFSCREEN_RAIL_BOTTOM_GAP_PX = 12

/** Use the same conservative ranking as the peer list; unknown uncertainty sorts last. */
export const offscreenPeerRank = (center: GeographicCenter, location: MapLocation): number =>
  proximityScoreMeters(center, location) ?? Number.POSITIVE_INFINITY

export const rankOffscreenPeers = (
  projected: readonly ProjectedMapLocation[],
  viewport: MapViewport,
  center: GeographicCenter,
  representedOnMap: ReadonlySet<string> = new Set(),
): readonly MapLocation[] =>
  projected
    .filter(
      ({ location, x, y }) =>
        !location.isOwn &&
        !representedOnMap.has(location.id) &&
        (x < 0 || x > viewport.width || y < 0 || y > viewport.height),
    )
    .sort(
      (left, right) =>
        offscreenPeerRank(center, left.location) - offscreenPeerRank(center, right.location) ||
        left.location.id.localeCompare(right.location.id),
    )
    .map(({ location }) => location)

/** The rail never exceeds half the map, nor overlaps the bottom-left area stack. */
export const offscreenRailCapacity = (mapHeight: number, bottomStackHeight: number): number => {
  const available = Math.min(
    mapHeight * 0.5,
    mapHeight - OFFSCREEN_RAIL_TOP_PX - bottomStackHeight - OFFSCREEN_RAIL_BOTTOM_GAP_PX,
  )
  if (available < OFFSCREEN_RAIL_ITEM_PX) return 0
  return Math.floor(
    (available + OFFSCREEN_RAIL_GAP_PX) / (OFFSCREEN_RAIL_ITEM_PX + OFFSCREEN_RAIL_GAP_PX),
  )
}
