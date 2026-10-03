import { layers, namedFlavor } from '@protomaps/basemaps'
import { addProtocol, removeProtocol, setWorkerUrl } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { PMTiles, Protocol } from 'pmtiles'

export const DEFAULT_WORLD_PMTILES_URL =
  'https://eu2.contabostorage.com/af09f5440e00407ca6d2d275a4a4dc89:protomaps/world.pmtiles'

export type MapFamily = 'default' | 'minimalist'
export type MapTheme = 'light' | 'dark'

export const MAP_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · ' +
  '<a href="https://github.com/protomaps/basemaps">Protomaps</a> · ' +
  '<a href="https://esa-worldcover.org/en">ESA WorldCover</a>'

export const mapFlavor = (family: MapFamily, theme: MapTheme): string =>
  family === 'default' ? theme : theme === 'dark' ? 'black' : 'grayscale'

export const createWorldStyle = (
  url: string,
  family: MapFamily,
  theme: MapTheme,
): StyleSpecification => {
  const flavor = mapFlavor(family, theme)
  const assets = new URL(`${import.meta.env.BASE_URL}map-assets/`, window.location.origin)
  return {
    version: 8,
    sprite: new URL(`sprites/v4/${flavor}`, assets).toString(),
    sources: {
      world: {
        type: 'vector',
        url: `pmtiles://${url}`,
        attribution: MAP_ATTRIBUTION,
      },
    },
    layers: layers('world', namedFlavor(flavor), { lang: 'en' }),
  }
}

const createMapLibreWorkerBootstrapUrl = (): string => {
  const compatibilityUrl = new URL(
    `${import.meta.env.BASE_URL}legacy-compat.js`,
    window.location.origin,
  ).toString()
  const compiledWorkerUrl = new URL(mapLibreWorkerUrl, window.location.origin).toString()
  return URL.createObjectURL(
    new Blob(
      [
        `import ${JSON.stringify(compatibilityUrl)};`,
        `import ${JSON.stringify(compiledWorkerUrl)};`,
      ],
      { type: 'text/javascript' },
    ),
  )
}

export const createPmtilesRuntime = () => {
  const protocol = new Protocol()
  let installed = false
  let workerBootstrapUrl: string | undefined

  return {
    setup: () => {
      if (installed) return
      workerBootstrapUrl = createMapLibreWorkerBootstrapUrl()
      setWorkerUrl(workerBootstrapUrl)
      addProtocol('pmtiles', protocol.tile)
      installed = true
    },
    verifyArchive: async (url: string): Promise<void> => {
      const archive = new PMTiles(url)
      protocol.add(archive)
      await archive.getHeader()
      await archive.getMetadata()
    },
    dispose: () => {
      if (!installed) return
      removeProtocol('pmtiles')
      if (workerBootstrapUrl) URL.revokeObjectURL(workerBootstrapUrl)
      workerBootstrapUrl = undefined
      installed = false
    },
  }
}
