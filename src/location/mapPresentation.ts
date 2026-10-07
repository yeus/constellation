import type { MapLocation } from './mapModel.ts'

export interface ProjectedMapLocation {
  readonly location: MapLocation
  readonly x: number
  readonly y: number
  readonly uncertaintyRadiusPx: number
}

export interface MapViewport {
  readonly width: number
  readonly height: number
}

export interface MapDeclutteringPreferences {
  readonly enabled: boolean
  readonly groupMarkerCollisions: boolean
  readonly groupUncertaintyOverlap: boolean
  readonly uncertaintyOverlapThreshold: number
  readonly markerCollisionDistancePx: number
}

export interface MapPeerGroup {
  readonly key: string
  readonly members: readonly MapLocation[]
  readonly x: number
  readonly y: number
  readonly radiusPx: number
}

export interface MapPresentation {
  readonly width: number
  readonly height: number
  readonly mapLocations: readonly MapLocation[]
  readonly groups: readonly MapPeerGroup[]
  readonly largePeers: readonly MapLocation[]
}

const intersectsViewport = (location: ProjectedMapLocation, viewport: MapViewport): boolean =>
  location.x + location.uncertaintyRadiusPx >= 0 &&
  location.x - location.uncertaintyRadiusPx <= viewport.width &&
  location.y + location.uncertaintyRadiusPx >= 0 &&
  location.y - location.uncertaintyRadiusPx <= viewport.height

const circleIntersectionOverUnion = (
  first: ProjectedMapLocation,
  second: ProjectedMapLocation,
): number => {
  const firstRadius = first.uncertaintyRadiusPx
  const secondRadius = second.uncertaintyRadiusPx
  const distance = Math.hypot(first.x - second.x, first.y - second.y)
  if (distance >= firstRadius + secondRadius) return 0
  const smallerArea = Math.PI * Math.min(firstRadius, secondRadius) ** 2
  if (distance <= Math.abs(firstRadius - secondRadius)) {
    const largerArea = Math.PI * Math.max(firstRadius, secondRadius) ** 2
    return smallerArea / largerArea
  }

  const firstCosine =
    (distance ** 2 + firstRadius ** 2 - secondRadius ** 2) / (2 * distance * firstRadius)
  const secondCosine =
    (distance ** 2 + secondRadius ** 2 - firstRadius ** 2) / (2 * distance * secondRadius)
  const firstAngle = 2 * Math.acos(Math.max(-1, Math.min(1, firstCosine)))
  const secondAngle = 2 * Math.acos(Math.max(-1, Math.min(1, secondCosine)))
  const intersection =
    (firstRadius ** 2 * (firstAngle - Math.sin(firstAngle)) +
      secondRadius ** 2 * (secondAngle - Math.sin(secondAngle))) /
    2
  const union = Math.PI * (firstRadius ** 2 + secondRadius ** 2) - intersection
  return intersection / union
}

const shouldGroup = (
  first: ProjectedMapLocation,
  second: ProjectedMapLocation,
  preferences: MapDeclutteringPreferences,
): boolean => {
  const markerCollision =
    preferences.groupMarkerCollisions &&
    Math.hypot(first.x - second.x, first.y - second.y) <= preferences.markerCollisionDistancePx
  const uncertaintyOverlap =
    preferences.groupUncertaintyOverlap &&
    first.uncertaintyRadiusPx > 0 &&
    second.uncertaintyRadiusPx > 0 &&
    circleIntersectionOverUnion(first, second) >= preferences.uncertaintyOverlapThreshold
  return markerCollision || uncertaintyOverlap
}

const enclosingCircle = (
  members: readonly ProjectedMapLocation[],
  minimumRadiusPx: number,
): Pick<MapPeerGroup, 'x' | 'y' | 'radiusPx'> => {
  const left = Math.min(...members.map(({ x, uncertaintyRadiusPx }) => x - uncertaintyRadiusPx))
  const right = Math.max(...members.map(({ x, uncertaintyRadiusPx }) => x + uncertaintyRadiusPx))
  const top = Math.min(...members.map(({ y, uncertaintyRadiusPx }) => y - uncertaintyRadiusPx))
  const bottom = Math.max(...members.map(({ y, uncertaintyRadiusPx }) => y + uncertaintyRadiusPx))
  const x = (left + right) / 2
  const y = (top + bottom) / 2
  const radiusPx = Math.max(
    minimumRadiusPx,
    ...members.map((member) => Math.hypot(member.x - x, member.y - y) + member.uncertaintyRadiusPx),
  )
  return { x, y, radiusPx }
}

const validateInputs = (
  projectedLocations: readonly ProjectedMapLocation[],
  viewport: MapViewport,
  preferences: MapDeclutteringPreferences,
): void => {
  if (
    !Number.isFinite(viewport.width) ||
    viewport.width <= 0 ||
    !Number.isFinite(viewport.height) ||
    viewport.height <= 0
  ) {
    throw new RangeError('Map viewport dimensions must be positive finite numbers.')
  }
  if (
    !Number.isFinite(preferences.uncertaintyOverlapThreshold) ||
    preferences.uncertaintyOverlapThreshold <= 0 ||
    preferences.uncertaintyOverlapThreshold > 1
  ) {
    throw new RangeError('Uncertainty overlap threshold must be greater than zero and at most one.')
  }
  if (
    !Number.isFinite(preferences.markerCollisionDistancePx) ||
    preferences.markerCollisionDistancePx <= 0
  ) {
    throw new RangeError('Marker collision distance must be a positive finite number.')
  }
  if (
    projectedLocations.some(
      ({ x, y, uncertaintyRadiusPx }) =>
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(uncertaintyRadiusPx) ||
        uncertaintyRadiusPx < 0,
    )
  ) {
    throw new RangeError('Projected map coordinates and radii must be finite and non-negative.')
  }
}

const findConnected = (
  remaining: readonly ProjectedMapLocation[],
  members: readonly ProjectedMapLocation[],
  preferences: MapDeclutteringPreferences,
): {
  readonly members: readonly ProjectedMapLocation[]
  readonly remaining: readonly ProjectedMapLocation[]
} => {
  const connected = remaining.filter((candidate) =>
    members.some((member) => shouldGroup(member, candidate, preferences)),
  )
  if (connected.length === 0) return { members, remaining }
  return findConnected(
    remaining.filter((candidate) => !connected.includes(candidate)),
    [...members, ...connected],
    preferences,
  )
}

const connectedComponents = (
  candidates: readonly ProjectedMapLocation[],
  preferences: MapDeclutteringPreferences,
): readonly (readonly ProjectedMapLocation[])[] => {
  const [first, ...remaining] = candidates
  if (!first) return []
  const component = findConnected(remaining, [first], preferences)
  return [component.members, ...connectedComponents(component.remaining, preferences)]
}

const createPeerGroups = (
  components: readonly (readonly ProjectedMapLocation[])[],
  minimumRadiusPx: number,
): readonly MapPeerGroup[] =>
  components
    .filter((members) => members.length > 1)
    .map((members) => {
      const sortedMembers = [...members].sort((left, right) =>
        left.location.id.localeCompare(right.location.id),
      )
      const ids = sortedMembers.map(({ location }) => location.id)
      return {
        key: ids.join(':'),
        members: sortedMembers.map(({ location }) => location),
        ...enclosingCircle(members, minimumRadiusPx),
      }
    })

export const createMapPresentation = (
  projectedLocations: readonly ProjectedMapLocation[],
  viewport: MapViewport,
  preferences: MapDeclutteringPreferences,
): MapPresentation => {
  validateInputs(projectedLocations, viewport, preferences)
  const largePeers = projectedLocations.filter(
    (entry) =>
      !entry.location.isOwn &&
      entry.uncertaintyRadiusPx * 2 > Math.min(viewport.width, viewport.height) &&
      intersectsViewport(entry, viewport),
  )
  const panelIds = new Set(largePeers.map(({ location }) => location.id))
  const candidates = preferences.enabled
    ? projectedLocations.filter(({ location }) => !location.isOwn && !panelIds.has(location.id))
    : []
  const groups = createPeerGroups(
    connectedComponents(candidates, preferences),
    preferences.markerCollisionDistancePx / 2,
  )
  const excludedIds = new Set([
    ...panelIds,
    ...groups.flatMap(({ members }) => members.map(({ id }) => id)),
  ])

  return {
    width: viewport.width,
    height: viewport.height,
    mapLocations: projectedLocations
      .map(({ location }) => location)
      .filter(({ id }) => !excludedIds.has(id)),
    groups,
    largePeers: largePeers.map(({ location }) => location),
  }
}
