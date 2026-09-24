<template>
  <div class="location-map">
    <div ref="mapElement" class="location-map__canvas" />
    <p v-if="mapNotice" class="location-map__notice" role="alert">
      {{ mapNotice }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { GeoJSONSource } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { describeDiagnosticError, type SessionLogInput } from '../diagnostics/sessionLog.ts'
import {
  createLocationFeatureCollection,
  locationAreaBounds,
  locationsBounds,
  type MapLocation,
} from '../location/mapModel.ts'
import {
  createPmtilesRuntime,
  createWorldStyle,
  DEFAULT_WORLD_PMTILES_URL,
  MAP_ATTRIBUTION,
  type MapFamily,
} from '../map/pmtiles.ts'

const LOCATION_SOURCE_ID = 'constellation-locations'

const props = withDefaults(
  defineProps<{
    locations: readonly MapLocation[]
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
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
const theme = ref<'light' | 'dark'>(darkScheme.matches ? 'dark' : 'light')
const runtime = createPmtilesRuntime()
let map: maplibregl.Map | null = null

const addLocationLayers = (target: maplibregl.Map): void => {
  if (target.getSource(LOCATION_SOURCE_ID)) return
  target.addSource(LOCATION_SOURCE_ID, {
    type: 'geojson',
    data: createLocationFeatureCollection(props.locations),
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
      'circle-color': [
        'match',
        ['get', 'state'],
        'stale',
        '#7b8794',
        ['coalesce', ['get', 'color'], '#f78f3b'],
      ],
      'circle-radius': 7,
      'circle-stroke-color': theme.value === 'dark' ? '#ffffff' : '#2a3548',
      'circle-stroke-width': 2,
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
    map = new maplibregl.Map({
      container: mapElement.value,
      style: createWorldStyle(props.pmtilesUrl, props.mapFamily, theme.value),
      center: [0, 20],
      zoom: 1.5,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right')
    map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: MAP_ATTRIBUTION }),
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
      if (map) addLocationLayers(map)
      emit('diagnostic', { level: 'info', event: 'map.style.loaded' })
    })
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

const updateLocations = (): void => {
  const source = map?.getSource<GeoJSONSource>(LOCATION_SOURCE_ID)
  if (source) source.setData(createLocationFeatureCollection(props.locations))
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

watch(() => props.locations, updateLocations, { deep: true })
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
