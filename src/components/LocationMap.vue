<template>
  <div class="location-map" :data-rendered="mapRendered">
    <div ref="mapElement" class="location-map__canvas" />
    <div class="location-map__overlays">
      <svg
        v-if="presentation.groups.length"
        class="location-map__group-areas"
        :viewBox="`0 0 ${presentation.width} ${presentation.height}`"
      >
        <circle
          v-for="group in presentation.groups"
          :key="group.key"
          class="location-map__group-area"
          role="button"
          tabindex="0"
          :aria-label="`Show all ${group.members.length} peers in this group`"
          :cx="group.x"
          :cy="group.y"
          :r="group.radiusPx"
          @click.stop="
            emit(
              'selectGroup',
              group.members.map((member) => member.id),
            )
          "
          @keydown.enter.prevent="
            emit(
              'selectGroup',
              group.members.map((member) => member.id),
            )
          "
          @keydown.space.prevent="
            emit(
              'selectGroup',
              group.members.map((member) => member.id),
            )
          "
        />
      </svg>
      <div
        v-for="group in presentation.groups"
        :key="group.key"
        class="location-map__group"
        :style="{ left: `${group.x}px`, top: `${group.y}px` }"
        @click.stop="
          emit(
            'selectGroup',
            group.members.map((member) => member.id),
          )
        "
      >
        <button
          v-for="member in group.members"
          :key="member.id"
          class="location-map__group-member"
          type="button"
          :aria-label="member.isOwn ? 'Open settings for my location' : peerMarkerLabel(member)"
          @click.stop="member.isOwn ? emit('selectOwn') : emit('select', member.id)"
        >
          <MapPeerAvatar :location="member" :now="displayNow" />
        </button>
      </div>
      <button
        v-for="marker in individualAvatars"
        :key="marker.location.id"
        class="location-map__single-avatar"
        type="button"
        :style="{ left: `${marker.x}px`, top: `${marker.y}px` }"
        :aria-label="peerMarkerLabel(marker.location)"
        @click.stop="emit('select', marker.location.id)"
      >
        <MapPeerAvatar :location="marker.location" :now="displayNow" />
      </button>
      <button
        v-if="ownMarker"
        class="location-map__own-marker"
        type="button"
        :style="{ left: `${ownMarker.x}px`, top: `${ownMarker.y}px` }"
        aria-label="Open settings for my location"
        @click.stop="emit('selectOwn')"
      >
        <MapPeerAvatar :location="ownMarker.location" :now="displayNow" />
      </button>
      <aside
        v-if="offscreenPeers.length && maxOffscreenItems > 0"
        class="location-map__offscreen-peers"
        aria-label="Following peers outside the map"
      >
        <button
          v-for="location in visibleOffscreenPeers"
          :key="location.id"
          type="button"
          :title="`Center map on ${location.label || 'shared location'}`"
          :aria-label="offscreenMarkerLabel(location)"
          @click.stop="centerOn(location)"
        >
          <MapPeerAvatar :location="location" :now="displayNow" />
        </button>
        <button
          v-if="offscreenPeers.length > maxOffscreenItems && maxOffscreenItems > 1"
          type="button"
          :aria-label="`Show all ${offscreenPeers.length} off-screen peers`"
          @click.stop="
            emit(
              'areaOverflow',
              offscreenPeers.map(({ id }) => id),
            )
          "
        >
          +{{ offscreenPeers.length - visibleOffscreenPeers.length }}
        </button>
      </aside>
      <aside
        v-if="presentation.largePeers.length"
        class="location-map__large-peers"
        aria-label="Peers around this area"
      >
        <button
          v-for="location in visibleLargePeers"
          :key="location.id"
          type="button"
          :aria-label="peerMarkerLabel(location)"
          @click.stop="emit('select', location.id)"
        >
          <MapPeerAvatar :location="location" :now="displayNow" />
        </button>
        <button
          v-if="presentation.largePeers.length > maxStackItems"
          type="button"
          aria-label="Show all peers in this area"
          @click.stop="
            emit(
              'areaOverflow',
              presentation.largePeers.map(({ id }) => id),
            )
          "
        >
          …
        </button>
      </aside>
    </div>
    <p v-if="mapNotice" class="location-map__notice" role="alert">
      {{ mapNotice }}
    </p>
  </div>
</template>

<script setup lang="ts">
import {
  AttributionControl,
  Map,
  NavigationControl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { describeDiagnosticError, type SessionLogInput } from '../diagnostics/sessionLog.ts'
import {
  createLocationFeatureCollection,
  locationUncertaintyRing,
  LOCATION_MARKER_RADIUS_PX,
  LOCATION_MARKER_STROKE_PX,
  locationAreaBounds,
  locationsBounds,
  type MapLocation,
} from '../location/mapModel.ts'
import {
  createMapPresentation,
  type MapDeclutteringPreferences,
  type MapPresentation,
} from '../location/mapPresentation.ts'
import {
  OFFSCREEN_RAIL_GAP_PX,
  OFFSCREEN_RAIL_ITEM_PX,
  offscreenRailCapacity,
  rankOffscreenPeers,
} from '../location/offscreenPeers.ts'
import {
  createPmtilesRuntime,
  createWorldStyle,
  DEFAULT_WORLD_PMTILES_URL,
  MAP_ATTRIBUTION,
  type MapFamily,
} from '../map/pmtiles.ts'
import type { MapCamera } from '../map/mapCamera.ts'
import { markerAgePresentation } from '../location/lastKnownMarker.ts'
import MapPeerAvatar from './MapPeerAvatar.vue'

const LOCATION_SOURCE_ID = 'constellation-locations'
const displayNow = ref(Date.now())
const peerMarkerLabel = (location: MapLocation): string => {
  const age = markerAgePresentation(location, displayNow.value).ageLabel
  return `Show ${location.label || 'shared location'} details${age ? `. ${age}` : ''}`
}
const offscreenMarkerLabel = (location: MapLocation): string => {
  const age = markerAgePresentation(location, displayNow.value).ageLabel
  return `Center map on ${location.label || 'shared location'}${age ? `. ${age}` : ''}`
}
let ageClock: number | undefined

const props = withDefaults(
  defineProps<{
    locations: readonly MapLocation[]
    decluttering: MapDeclutteringPreferences
    pmtilesUrl?: string
    mapFamily?: MapFamily
    initialCamera?: MapCamera
    cacheMaxBytes?: number
  }>(),
  { pmtilesUrl: DEFAULT_WORLD_PMTILES_URL, mapFamily: 'default' },
)
const emit = defineEmits<{
  select: [shareId: string]
  selectOwn: []
  selectGroup: [shareIds: string[]]
  ownAreaHidden: [hidden: boolean]
  areaOverflow: [shareIds: string[]]
  diagnostic: [entry: SessionLogInput]
  cameraChange: [camera: MapCamera]
  userPan: []
}>()

const mapElement = ref<HTMLDivElement | null>(null)
const mapNotice = ref('')
const mapRendered = ref(false)
const presentation = ref<MapPresentation>({
  width: 0,
  height: 0,
  mapLocations: [],
  groups: [],
  largePeers: [],
  ownAreaHidden: false,
})
const offscreenPeers = ref<readonly MapLocation[]>([])
const maxStackItems = computed(() => {
  const height = presentation.value.height
  const previousLimit = Math.max(1, Math.floor(Math.max(0, height - 160) / 49))
  // Reserve the top half for off-screen peers if both left-hand stacks exist.
  return offscreenPeers.value.length
    ? Math.min(previousLimit, Math.max(1, Math.floor((height * 0.35) / 49)))
    : previousLimit
})
const visibleLargePeers = computed(() =>
  presentation.value.largePeers.slice(
    0,
    presentation.value.largePeers.length > maxStackItems.value
      ? maxStackItems.value - 1
      : maxStackItems.value,
  ),
)
const bottomStackHeight = computed(() => {
  const count = Math.min(presentation.value.largePeers.length, maxStackItems.value)
  return 20 + count * OFFSCREEN_RAIL_ITEM_PX + Math.max(0, count - 1) * OFFSCREEN_RAIL_GAP_PX
})
const maxOffscreenItems = computed(() =>
  offscreenRailCapacity(presentation.value.height, bottomStackHeight.value),
)
const visibleOffscreenPeers = computed(() => {
  const limit = maxOffscreenItems.value
  const shown = offscreenPeers.value.length > limit && limit > 1 ? limit - 1 : limit
  return offscreenPeers.value.slice(0, shown)
})
const individualAvatars = ref<{ location: MapLocation; x: number; y: number }[]>([])
const ownMarker = ref<{ location: MapLocation; x: number; y: number }>()
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
const theme = ref<'light' | 'dark'>(darkScheme.matches ? 'dark' : 'light')
const runtime = createPmtilesRuntime({ maxBytes: props.cacheMaxBytes })
let map: Map | null = null
let presentationFrame: number | undefined

const addLocationLayers = (target: Map): void => {
  if (target.getSource(LOCATION_SOURCE_ID)) return
  target.addSource(LOCATION_SOURCE_ID, {
    type: 'geojson',
    data: createLocationFeatureCollection(props.locations, target.getZoom()),
  })
  target.addLayer({
    id: `${LOCATION_SOURCE_ID}-areas`,
    type: 'fill',
    source: LOCATION_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': ['coalesce', ['get', 'color'], '#f78f3b'],
      'fill-opacity': ['match', ['get', 'state'], 'stale', 0.1, 'delayed', 0.18, 0.26],
    },
  })
  target.addLayer({
    id: `${LOCATION_SOURCE_ID}-outlines`,
    type: 'line',
    source: LOCATION_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#f78f3b'], 'line-width': 2 },
  })
  target.addLayer({
    id: `${LOCATION_SOURCE_ID}-points`,
    type: 'circle',
    source: LOCATION_SOURCE_ID,
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'isOwn'], true]],
    paint: {
      'circle-color': ['coalesce', ['get', 'color'], '#f78f3b'],
      'circle-opacity': ['match', ['get', 'state'], 'stale', 0.45, 'delayed', 0.7, 1],
      'circle-radius': LOCATION_MARKER_RADIUS_PX,
      'circle-stroke-color': theme.value === 'dark' ? '#ffffff' : '#2a3548',
      'circle-stroke-width': LOCATION_MARKER_STROKE_PX,
    },
  })
}

const canRenderWebGL = (): boolean => {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  context?.getExtension('WEBGL_lose_context')?.loseContext()
  return context !== null
}

const showMapUnavailable = (): void => {
  mapNotice.value = 'WebGL unavailable: this browser could not create a rendering context.'
  emit('diagnostic', { level: 'error', event: 'map.webgl.unavailable' })
}

const handleMapClick = (target: Map, event: MapMouseEvent): void => {
  if (map !== target) return
  const layers = [`${LOCATION_SOURCE_ID}-points`, `${LOCATION_SOURCE_ID}-areas`].filter((id) =>
    target.getLayer(id),
  )
  if (layers.length === 0) return
  const feature = target.queryRenderedFeatures(event.point, { layers })[0]
  const id = feature?.properties?.id
  if (typeof id !== 'string') return
  if (feature?.properties?.isOwn === true) emit('selectOwn')
  else emit('select', id)
}

const handleStyleLoad = (target: Map): void => {
  if (map === target) {
    addLocationLayers(target)
    refreshPresentation()
  }
  emit('diagnostic', { level: 'info', event: 'map.style.loaded' })
}

const handleMapIdle = (target: Map): void => {
  if (map !== target) return
  mapRendered.value = Boolean(
    target.loaded() && target.queryRenderedFeatures().some((feature) => feature.source === 'world'),
  )
}

const handleMapError = (error: unknown): void => {
  const detail = describeDiagnosticError(error)
  mapNotice.value = `Map error (${detail.category}): ${detail.message}`
  emit('diagnostic', { level: 'error', event: 'map.error', ...detail })
}

const verifyMapArchive = (): void => {
  void runtime.verifyArchive(props.pmtilesUrl).then(
    () => emit('diagnostic', { level: 'info', event: 'map.archive.verified' }),
    (error: unknown) => {
      const detail = describeDiagnosticError(error)
      mapNotice.value = `Basemap error (${detail.category}): ${detail.message}`
      emit('diagnostic', { level: 'error', event: 'map.archive.failed', ...detail })
    },
  )
}

const configureMapEvents = (target: Map): void => {
  target.on('click', (event) => handleMapClick(target, event))
  target.on('style.load', () => handleStyleLoad(target))
  target.on('dragstart', () => emit('userPan'))
  target.on('idle', () => handleMapIdle(target))
  target.on('move', schedulePresentation)
  target.on('zoom', refreshPresentation)
  target.on('resize', schedulePresentation)
  target.on('moveend', () => {
    if (target !== map) return
    const center = target.getCenter()
    emit('cameraChange', { longitude: center.lng, latitude: center.lat, zoom: target.getZoom() })
  })
  target.on('error', ({ error }) => handleMapError(error))
}

const initialize = (): void => {
  if (!mapElement.value || map) return
  try {
    if (!canRenderWebGL()) {
      showMapUnavailable()
      return
    }
    runtime.setup()
    emit('diagnostic', { level: 'info', event: 'map.runtime.ready' })
    map = new Map({
      container: mapElement.value,
      style: createWorldStyle(props.pmtilesUrl, props.mapFamily, theme.value),
      center: props.initialCamera
        ? [props.initialCamera.longitude, props.initialCamera.latitude]
        : [0, 20],
      zoom: props.initialCamera?.zoom ?? 1.5,
      attributionControl: false,
    })
    map.addControl(new NavigationControl(), 'bottom-right')
    map.addControl(
      new AttributionControl({ compact: false, customAttribution: MAP_ATTRIBUTION }),
      'bottom-right',
    )
    configureMapEvents(map)
    verifyMapArchive()
  } catch (error) {
    map?.remove()
    map = null
    runtime.dispose()
    const detail = describeDiagnosticError(error)
    mapNotice.value = `Map initialization error (${detail.category}): ${detail.message}`
    emit('diagnostic', { level: 'error', event: 'map.error', ...detail })
  }
}

const updatePresentation = (): void => {
  if (!map) return
  const { clientWidth, clientHeight } = map.getContainer()
  const projectedLocations = props.locations.map((location) => {
    const center = map!.project([location.longitude, location.latitude])
    const radius = locationUncertaintyRing(location).reduce((largest, coordinate) => {
      const point = map!.project(coordinate)
      return Math.max(largest, Math.hypot(point.x - center.x, point.y - center.y))
    }, 0)
    return { location, x: center.x, y: center.y, uncertaintyRadiusPx: radius }
  })
  const next = createMapPresentation(
    projectedLocations,
    { width: clientWidth, height: clientHeight },
    props.decluttering,
  )
  if (next.ownAreaHidden !== presentation.value.ownAreaHidden)
    emit('ownAreaHidden', next.ownAreaHidden)
  presentation.value = next
  const represented = new Set([
    ...next.largePeers.map(({ id }) => id),
    ...next.groups
      .filter(({ x, y }) => x >= 0 && x <= clientWidth && y >= 0 && y <= clientHeight)
      .flatMap(({ members }) => members.map(({ id }) => id)),
  ])
  const mapCenter = map.getCenter()
  offscreenPeers.value = rankOffscreenPeers(
    projectedLocations,
    { width: clientWidth, height: clientHeight },
    { latitude: mapCenter.lat, longitude: mapCenter.lng },
    represented,
  )
  const visible = new Set(next.mapLocations.map(({ id }) => id))
  const ownPosition = projectedLocations.find(
    ({ location, x, y }) =>
      location.isOwn &&
      visible.has(location.id) &&
      x >= 0 &&
      x <= clientWidth &&
      y >= 0 &&
      y <= clientHeight,
  )
  ownMarker.value = ownPosition
    ? { location: ownPosition.location, x: ownPosition.x, y: ownPosition.y }
    : undefined
  individualAvatars.value = projectedLocations
    .filter(
      ({ location, x, y }) =>
        !location.isOwn &&
        visible.has(location.id) &&
        x >= 0 &&
        x <= clientWidth &&
        y >= 0 &&
        y <= clientHeight,
    )
    .map(({ location, x, y }) => ({ location, x, y }))
}

const updateFeatureData = (): void => {
  if (!map) return
  const source = map.getSource<GeoJSONSource>(LOCATION_SOURCE_ID)
  if (source)
    void source.setData(
      createLocationFeatureCollection(presentation.value.mapLocations, map.getZoom()),
    )
}

const refreshPresentation = (): void => {
  updatePresentation()
  updateFeatureData()
}

const schedulePresentation = (): void => {
  if (presentationFrame !== undefined) return
  presentationFrame = window.requestAnimationFrame(() => {
    presentationFrame = undefined
    refreshPresentation()
  })
}

const updateTheme = (event: MediaQueryListEvent): void => {
  theme.value = event.matches ? 'dark' : 'light'
  map?.setStyle(createWorldStyle(props.pmtilesUrl, props.mapFamily, theme.value))
}

const fitAreaBounds = (bounds: [[number, number], [number, number]]): void => {
  if (!map) return
  const { clientWidth, clientHeight } = map.getContainer()
  map.fitBounds(bounds, {
    padding: {
      top: Math.min(80, clientHeight / 4),
      bottom: Math.min(80, clientHeight / 4),
      left: Math.min(40, clientWidth / 8),
      right: Math.min(40, clientWidth / 8),
    },
    maxZoom: 17,
  })
}
const centerOn = (location: MapLocation): void => {
  if (!map) return
  const bounds = locationAreaBounds(location)
  if (bounds) fitAreaBounds(bounds)
  else
    map.flyTo({
      center: [location.longitude, location.latitude],
      zoom: Math.max(map.getZoom(), 13),
    })
}
const focusLocations = (locations: readonly MapLocation[]): void => {
  const bounds = locationsBounds(locations)
  if (bounds) fitAreaBounds(bounds)
}
defineExpose({
  centerOn,
  focusLocations,
  cacheStats: () => runtime.cacheStats(),
  clearCache: () => runtime.clearCache(),
  setCacheMaxBytes: (value: number) => runtime.setCacheMaxBytes(value),
})

watch(() => props.locations, refreshPresentation, { deep: true })
watch(() => props.decluttering, refreshPresentation, { deep: true })
watch(
  () => props.mapFamily,
  () => map?.setStyle(createWorldStyle(props.pmtilesUrl, props.mapFamily, theme.value)),
)
watch(
  () => props.cacheMaxBytes,
  (value) => runtime.setCacheMaxBytes(Math.max(0, value ?? 0)),
)
onMounted(() => {
  darkScheme.addEventListener('change', updateTheme)
  ageClock = window.setInterval(() => (displayNow.value = Date.now()), 60_000)
  initialize()
})
onBeforeUnmount(() => {
  darkScheme.removeEventListener('change', updateTheme)
  if (ageClock !== undefined) window.clearInterval(ageClock)
  if (presentationFrame !== undefined) window.cancelAnimationFrame(presentationFrame)
  map?.remove()
  map = null
  runtime.dispose()
})
</script>

<style scoped>
.location-map,
.location-map__canvas {
  width: 100%;
  height: 100%;
}

.location-map {
  position: relative;
}

.location-map__overlays {
  position: absolute;
  z-index: 2;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.location-map__group-areas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.location-map__group-area {
  fill: rgba(67, 142, 201, 0.09);
  stroke: #438ec9;
  stroke-width: 2;
  stroke-dasharray: 6 3;
  vector-effect: non-scaling-stroke;
  pointer-events: auto;
  cursor: pointer;
}
.location-map__group-area:focus-visible {
  outline: 2px solid #438ec9;
  outline-offset: 3px;
}

.location-map__group {
  position: absolute;
  display: grid;
  grid-template-columns: repeat(2, 2rem);
  gap: 0.15rem;
  padding: 0.15rem;
  transform: translate(-50%, -50%);
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: var(--surface);
  box-shadow: 0 2px 8px var(--sheet-shadow);
  pointer-events: auto;
}

.location-map__single-avatar {
  position: absolute;
  display: grid;
  width: 2.35rem;
  height: 2.35rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--surface);
  transform: translate(-50%, -50%);
  pointer-events: auto;
  cursor: pointer;
}
.location-map__own-marker {
  position: absolute;
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  transform: translate(-50%, -50%);
  pointer-events: auto;
  cursor: pointer;
}
.location-map__own-marker:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 7px;
  border-radius: 50%;
}
.location-map__group-member {
  display: grid;
  width: 2rem;
  height: 2rem;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}

.location-map__group-member :deep(.peer-avatar) {
  width: 1.9rem;
  height: 1.9rem;
  font-size: 0.65rem;
}

.location-map__large-peers,
.location-map__offscreen-peers {
  position: absolute;
  left: 0.75rem;
  display: grid;
  width: 2.6rem;
  gap: 0.45rem;
  pointer-events: auto;
}
.location-map__large-peers {
  bottom: 1.25rem;
  max-height: calc(100% - 9rem);
  align-content: end;
}
.location-map__offscreen-peers {
  top: 6rem;
  max-height: 50%;
  align-content: start;
}
.location-map__large-peers button,
.location-map__offscreen-peers button {
  display: grid;
  width: 2.6rem;
  height: 2.6rem;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text);
  font-size: 1.2rem;
  cursor: pointer;
}
.location-map__large-peers :deep(.peer-avatar),
.location-map__offscreen-peers :deep(.peer-avatar) {
  width: 2.5rem;
  height: 2.5rem;
}

:deep(.maplibregl-ctrl-bottom-right) {
  bottom: 0;
}

:deep(.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group) {
  position: absolute;
  right: 0;
  bottom: calc(2.25rem + var(--map-control-lift, 0rem));
}

:deep(.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group button) {
  width: 44px;
  height: 44px;
}
:deep(.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group button .maplibregl-ctrl-icon) {
  background-size: 33px 33px;
}

:deep(.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib) {
  position: relative;
  bottom: var(--map-control-lift, 0rem);
  margin: 0 4px 2px 0;
  padding: 0;
  background: transparent;
  color: var(--text);
  font-size: 0.625rem;
  line-height: 1.1;
  text-align: right;
  text-shadow: 0 1px 2px var(--page-background);
}

:deep(.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-attrib a) {
  color: var(--text);
}

.location-map__notice {
  position: absolute;
  z-index: 1;
  top: 4.25rem;
  left: 1rem;
  right: 1rem;
  width: fit-content;
  max-width: min(22rem, calc(100% - 2rem));
  margin: 0;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--error-border);
  border-radius: 0.8rem;
  background: var(--error-background);
  color: var(--error-text);
  font-size: 0.75rem;
  backdrop-filter: blur(18px);
}

:deep(.maplibregl-ctrl-group) {
  background: var(--map-navigation-surface);
  border: 1px solid var(--border);
  box-shadow: 0 2px 6px var(--sheet-shadow);
  backdrop-filter: blur(12px);
}
:deep(.maplibregl-ctrl-group button + button) {
  border-top-color: var(--border);
}
:deep(.maplibregl-ctrl-group button:hover) {
  background-color: var(--privacy-fill);
}
:deep(.maplibregl-ctrl-group button:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
@media (prefers-color-scheme: dark) {
  :deep(.maplibregl-ctrl-group button .maplibregl-ctrl-icon) {
    filter: invert(1);
  }
}
</style>
