import type { Map as MapLibreMap } from 'maplibre-gl'
import maplibregl from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url'
import { PMTiles, Protocol } from 'pmtiles'

export const DEFAULT_WORLD_PMTILES_URL =
  'https://eu2.contabostorage.com/af09f5440e00407ca6d2d275a4a4dc89:protomaps/world.pmtiles'

export interface PmtilesRuntime {
  setup: () => void
  dispose: () => void
  addWorldMap: (map: MapLibreMap, url: string, theme: 'light' | 'dark') => Promise<void>
  updateTheme: (map: MapLibreMap, theme: 'light' | 'dark') => void
}

const WORLD_SOURCE_ID = 'constellation-world'
const fillPalette = ['#3f4953', '#495662', '#55616c', '#606b75', '#6a7580', '#737f89']

const vectorLayerNames = (metadata: unknown): string[] => {
  if (!metadata || typeof metadata !== 'object') return []
  const raw = (metadata as Record<string, unknown>).vector_layers
  const decoded = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!Array.isArray(decoded)) return []
  return decoded
    .map((entry) =>
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>).id : undefined,
    )
    .filter((id): id is string => typeof id === 'string')
}

const addLayers = (
  map: MapLibreMap,
  sourceId: string,
  sourceLayers: readonly string[],
  theme: 'light' | 'dark',
): void => {
  sourceLayers.forEach((sourceLayer, index) => {
    const color = fillPalette[index % fillPalette.length] ?? '#55616c'
    map.addLayer({
      id: `${sourceId}-${index}-fill`,
      type: 'fill',
      source: sourceId,
      'source-layer': sourceLayer,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': color,
        'fill-opacity': theme === 'dark' ? 0.08 : 0.12,
      },
    })
    map.addLayer({
      id: `${sourceId}-${index}-line`,
      type: 'line',
      source: sourceId,
      'source-layer': sourceLayer,
      paint: {
        'line-color': theme === 'dark' ? '#697682' : '#8b969f',
        'line-width': 0.7,
        'line-opacity': 0.65,
      },
    })
    map.addLayer({
      id: `${sourceId}-${index}-point`,
      type: 'circle',
      source: sourceId,
      'source-layer': sourceLayer,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-color': theme === 'dark' ? '#88949f' : '#66727c',
        'circle-radius': 2,
        'circle-opacity': 0.5,
      },
    })
  })
}

export const createPmtilesRuntime = (): PmtilesRuntime => {
  const protocol = new Protocol()
  let installed = false
  let sourceLayers: string[] = []

  return {
    setup: () => {
      if (installed) return
      maplibregl.setWorkerUrl(mapLibreWorkerUrl)
      maplibregl.addProtocol('pmtiles', protocol.tile)
      installed = true
    },
    dispose: () => {
      if (installed) {
        maplibregl.removeProtocol('pmtiles')
        installed = false
      }
      sourceLayers = []
    },
    addWorldMap: async (map, url, theme) => {
      const archive = new PMTiles(url)
      protocol.add(archive)
      const metadata = await archive.getMetadata()
      await archive.getHeader()
      sourceLayers = vectorLayerNames(metadata)
      map.addSource(WORLD_SOURCE_ID, { type: 'vector', url: `pmtiles://${url}` })
      addLayers(map, WORLD_SOURCE_ID, sourceLayers, theme)
    },
    updateTheme: (map, theme) => {
      sourceLayers.forEach((_, index) => {
        const prefix = `${WORLD_SOURCE_ID}-${index}`
        const fillId = `${prefix}-fill`
        const lineId = `${prefix}-line`
        const pointId = `${prefix}-point`
        if (map.getLayer(fillId)) {
          map.setPaintProperty(fillId, 'fill-opacity', theme === 'dark' ? 0.08 : 0.12)
        }
        if (map.getLayer(lineId)) {
          map.setPaintProperty(lineId, 'line-color', theme === 'dark' ? '#697682' : '#8b969f')
        }
        if (map.getLayer(pointId)) {
          map.setPaintProperty(pointId, 'circle-color', theme === 'dark' ? '#88949f' : '#66727c')
        }
      })
    },
  }
}
