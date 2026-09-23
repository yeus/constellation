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

const style = (): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': theme.value === 'dark' ? '#111822' : '#e8edf2',
      },
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

const initialize = (): void => {
  if (!mapElement.value || map) return
  runtime.setup()
  map = new maplibregl.Map({
    container: mapElement.value,
    style: style(),
    center: [0, 20],
    zoom: 1.5,
    attributionControl: false,
  })
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right')
  map.on('load', () => {
    void (async () => {
      if (!map) return
      try {
        await runtime.addWorldMap(map, props.pmtilesUrl, theme.value)
      } catch {
        mapNotice.value = 'Basemap unavailable; location sharing remains available.'
      }
      addLocationLayers(map)
    })()
  })
}

const updateLocations = (): void => {
  const source = map?.getSource<GeoJSONSource>(LOCATION_SOURCE_ID)
  source?.setData(createLocationFeatureCollection(props.locations))
}

const updateTheme = (event: MediaQueryListEvent): void => {
  theme.value = event.matches ? 'dark' : 'light'
  map?.setPaintProperty('background', 'background-color', event.matches ? '#111822' : '#e8edf2')
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

.location-map__notice {
  position: absolute;
  right: 1rem;
  bottom: 1rem;
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
