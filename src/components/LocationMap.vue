<template>
  <div class="location-map" :data-rendered="mapRendered">
    <div ref="mapElement" class="location-map__canvas" />
    <div class="location-map__overlays">
      <svg
        v-if="presentation.groups.length"
        class="location-map__group-areas"
        :viewBox="`0 0 ${presentation.width} ${presentation.height}`"
        aria-hidden="true"
      >
        <circle
          v-for="group in presentation.groups"
          :key="group.key"
          class="location-map__group-area"
          :cx="group.x"
          :cy="group.y"
          :r="group.radiusPx"
        />
      </svg>
      <div
        v-for="group in presentation.groups"
        :key="group.key"
        class="location-map__group"
        :style="{ left: `${group.x}px`, top: `${group.y}px` }"
      >
        <button
          v-for="member in group.members"
          :key="member.id"
          class="location-map__group-member"
          type="button"
          :aria-label="`Show ${member.label || 'shared location'} details`"
          @click.stop="emit('select', member.id)"
        >
          <PeerAvatar :name="member.label || 'Shared location'" :color="member.color" />
        </button>
      </div>
      <aside
        v-if="presentation.largePeers.length"
        class="location-map__large-peers"
        aria-label="Peers around this area"
      >
        <h2>Peers around this area</h2>
        <button
          v-for="location in presentation.largePeers"
          :key="location.id"
          type="button"
          @click.stop="emit('select', location.id)"
        >
          <PeerAvatar :name="location.label || 'Shared location'" :color="location.color" />
          <span>{{ location.label || 'Shared location' }}</span>
        </button>
      </aside>
    </div>
    <p v-if="mapNotice" class="location-map__notice" role="alert">
      {{ mapNotice }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { AttributionControl, Map, NavigationControl, type GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
  createPmtilesRuntime,
  createWorldStyle,
  DEFAULT_WORLD_PMTILES_URL,
  MAP_ATTRIBUTION,
  type MapFamily,
} from '../map/pmtiles.ts'
import PeerAvatar from './PeerAvatar.vue'

const LOCATION_SOURCE_ID = 'constellation-locations'

const props = withDefaults(
  defineProps<{
    locations: readonly MapLocation[]
    decluttering: MapDeclutteringPreferences
    pmtilesUrl?: string
    mapFamily?: MapFamily
  }>(),
  { pmtilesUrl: DEFAULT_WORLD_PMTILES_URL, mapFamily: 'default' },
)
const emit = defineEmits<{
  select: [shareId: string]
  diagnostic: [entry: SessionLogInput]
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
})
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
const theme = ref<'light' | 'dark'>(darkScheme.matches ? 'dark' : 'light')
const runtime = createPmtilesRuntime()
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
    filter: ['==', ['geometry-type'], 'Point'],
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
      center: [0, 20],
      zoom: 1.5,
      attributionControl: false,
    })
    map.addControl(new NavigationControl(), 'bottom-right')
    map.addControl(
      new AttributionControl({ compact: false, customAttribution: MAP_ATTRIBUTION }),
      'bottom-right',
    )
    map.on('click', (event) => {
      if (!map) return
      const layers = [`${LOCATION_SOURCE_ID}-points`, `${LOCATION_SOURCE_ID}-areas`].filter((id) =>
        map?.getLayer(id),
      )
      if (layers.length === 0) return
      const id = map.queryRenderedFeatures(event.point, { layers })[0]?.properties?.id
      if (typeof id === 'string') emit('select', id)
    })
    map.on('style.load', () => {
      if (map) {
        addLocationLayers(map)
        refreshPresentation()
      }
      emit('diagnostic', { level: 'info', event: 'map.style.loaded' })
    })
    map.on('idle', () => {
      mapRendered.value = Boolean(
        map?.loaded() && map.queryRenderedFeatures().some((feature) => feature.source === 'world'),
      )
    })
    map.on('move', schedulePresentation)
    map.on('zoom', refreshPresentation)
    map.on('resize', schedulePresentation)
    map.on('error', ({ error }) => {
      const detail = describeDiagnosticError(error)
      mapNotice.value = `Map error (${detail.category}): ${detail.message}`
      emit('diagnostic', { level: 'error', event: 'map.error', ...detail })
    })
    void runtime.verifyArchive(props.pmtilesUrl).then(
      () => emit('diagnostic', { level: 'info', event: 'map.archive.verified' }),
      (error: unknown) => {
        const detail = describeDiagnosticError(error)
        mapNotice.value = `Basemap error (${detail.category}): ${detail.message}`
        emit('diagnostic', { level: 'error', event: 'map.archive.failed', ...detail })
      },
    )
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
  presentation.value = next
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
    updatePresentation()
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
defineExpose({ centerOn, focusLocations })

watch(() => props.locations, refreshPresentation, { deep: true })
watch(() => props.decluttering, refreshPresentation, { deep: true })
watch(
  () => props.mapFamily,
  () => map?.setStyle(createWorldStyle(props.pmtilesUrl, props.mapFamily, theme.value)),
)
onMounted(() => {
  darkScheme.addEventListener('change', updateTheme)
  initialize()
})
onBeforeUnmount(() => {
  darkScheme.removeEventListener('change', updateTheme)
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

.location-map__large-peers {
  position: absolute;
  top: 4.25rem;
  left: 0.75rem;
  display: grid;
  width: min(15rem, calc(100% - 1.5rem));
  max-height: min(34vh, 18rem);
  gap: 0.25rem;
  overflow-y: auto;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.8rem;
  background: var(--surface);
  box-shadow: 0 2px 12px var(--sheet-shadow);
  pointer-events: auto;
}

.location-map__large-peers h2 {
  margin: 0 0 0.2rem;
  font-size: 0.75rem;
}

.location-map__large-peers button {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.location-map__large-peers button:hover {
  background: var(--control-fill);
}

.location-map__large-peers :deep(.peer-avatar) {
  width: 1.9rem;
  height: 1.9rem;
  font-size: 0.65rem;
}

@media (max-width: 699px) {
  .location-map__large-peers {
    top: calc(4.25rem + 4rem + env(safe-area-inset-top));
  }
}

:deep(.maplibregl-ctrl-bottom-right) {
  bottom: 0;
}

:deep(.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group) {
  position: absolute;
  right: 0;
  bottom: calc(2.25rem + var(--map-control-lift, 0rem));
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
</style>
