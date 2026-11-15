import { distanceMeters } from './approximation.ts'
import type { MapLocation } from './mapModel.ts'

interface RankedPeer {
  readonly key: string
  readonly name: string
  readonly following: readonly { readonly shareId: string }[]
}

const validPosition = ({
  latitude,
  longitude,
}: Pick<MapLocation, 'latitude' | 'longitude'>): boolean =>
  Number.isFinite(latitude) &&
  Math.abs(latitude) <= 90 &&
  Number.isFinite(longitude) &&
  Math.abs(longitude) <= 180

// Conservative distance to a peer's possible location, not an inferred exact position.
// Missing or invalid uncertainty must never be interpreted as a zero-metre radius.
export const proximityScoreMeters = (
  own: Pick<MapLocation, 'latitude' | 'longitude'>,
  peer: MapLocation,
): number | undefined => {
  if (!validPosition(own) || !validPosition(peer)) return undefined
  const radius = peer.precision === 'approximate' ? peer.radiusMeters : peer.accuracyMeters
  if (radius === undefined || !Number.isFinite(radius) || radius < 0) return undefined
  return distanceMeters(own.latitude, own.longitude, peer.latitude, peer.longitude) + radius
}

export const rankPeersByProximity = <T extends RankedPeer>(
  peers: readonly T[],
  locations: readonly MapLocation[],
): T[] => {
  const own = locations.find(({ isOwn }) => isOwn)
  const locationsByShare = new Map(
    locations.filter(({ isOwn }) => !isOwn).map((location) => [location.id, location]),
  )
  const compareNames = (left: T, right: T): number =>
    left.name.localeCompare(right.name) || left.key.localeCompare(right.key)

  return peers
    .map((peer) => ({
      peer,
      score: own
        ? Math.min(
            ...peer.following.map(({ shareId }) => {
              const location = locationsByShare.get(shareId)
              return location === undefined
                ? Infinity
                : (proximityScoreMeters(own, location) ?? Infinity)
            }),
          )
        : Infinity,
    }))
    .sort(
      (left, right) =>
        (Number.isFinite(left.score) && Number.isFinite(right.score)
          ? left.score - right.score
          : Number.isFinite(left.score)
            ? -1
            : Number.isFinite(right.score)
              ? 1
              : 0) || compareNames(left.peer, right.peer),
    )
    .map(({ peer }) => peer)
}
