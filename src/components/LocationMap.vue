<template>
  <div class="location-map">
    <div ref="mapElement" class="location-map__canvas" />
    <p v-if="mapNotice" class="location-map__notice" role="status">
      {{ mapNotice }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { createLocationFeatureCollection, type MapLocation } from '../location/mapModel.ts'
import { createPmtilesRuntime, DEFAULT_WORLD_PMTILES_URL } from '../map/pmtiles.ts'

const LOCATION_SOURCE_ID = 'constellation-locations'

const props = withDefaults(
  defineProps<{
    locations: readonly MapLocation[]
    pmtilesUrl?: string
  }>(),
  { pmtilesUrl: DEFAULT_WORLD_PMTILES_URL },
)

const mapElement = ref<HTMLDivElement | null>(null)
const mapNotice = ref('')
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
const theme = ref<'light' | 'dark'>(darkScheme.matches ? 'dark' : 'light')
const runtime = createPmtilesRuntime()
let map: maplibregl.Map | null = null

const mapBackground = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue('--map-background').trim()

const style = (): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': mapBackground() },
    },
  ],
})

const addLocationLayers = (target: maplibregl.Map): void => {
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
      'fill-color': '#f78f3b',
      'fill-opacity': ['match', ['get', 'state'], 'stale', 0.1, 'delayed', 0.18, 0.26],
    },
  })
  target.addLayer({
    id: `${LOCATION_SOURCE_ID}-outlines`,
    type: 'line',
    source: LOCATION_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': '#f78f3b', 'line-width': 2 },
  })
  target.addLayer({
    id: `${LOCATION_SOURCE_ID}-points`,
    type: 'circle',
    source: LOCATION_SOURCE_ID,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': ['match', ['get', 'state'], 'stale', '#7b8794', '#f78f3b'],
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
  mapNotice.value = 'Map rendering unavailable; location sharing remains available.'
}

const initialize = (): void => {
  if (!mapElement.value || map) return
  try {
    if (!canRenderWebGL()) {
      showMapUnavailable()
      return
    }
    runtime.setup()
    map = new maplibregl.Map({
      container: mapElement.value,
      style: style(),
      center: [0, 20],
      zoom: 1.5,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right')
    map.on('error', () => {
      if (!mapNotice.value) {
        mapNotice.value = 'Map tiles could not be displayed; location sharing remains available.'
      }
    })
    map.on('load', () => {
      void (async () => {
        if (!map) return
        try {
          await runtime.addWorldMap(map, props.pmtilesUrl, theme.value)
        } catch {
          mapNotice.value = 'Basemap data could not be loaded; location sharing remains available.'
        }
        runtime.updateTheme(map, theme.value)
        addLocationLayers(map)
      })()
    })
  } catch {
    map?.remove()
    map = null
    runtime.dispose()
    showMapUnavailable()
  }
}

const updateLocations = (): void => {
  const source = map?.getSource<GeoJSONSource>(LOCATION_SOURCE_ID)
  source?.setData(createLocationFeatureCollection(props.locations))
}

const updateTheme = (event: MediaQueryListEvent): void => {
  theme.value = event.matches ? 'dark' : 'light'
  map?.setPaintProperty('background', 'background-color', mapBackground())
  if (map) runtime.updateTheme(map, theme.value)
}

watch(() => props.locations, updateLocations, { deep: true })
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
  bottom: 12rem;
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
  border: 1px solid var(--border);
  border-radius: 0.8rem;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.75rem;
  backdrop-filter: blur(18px);
}
</style>
