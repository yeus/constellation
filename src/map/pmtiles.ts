import type { Map as MapLibreMap } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-csp-worker.js?url";
import { PMTiles, Protocol } from "pmtiles";

export const DEFAULT_WORLD_PMTILES_URL =
  "https://eu2.contabostorage.com/af09f5440e00407ca6d2d275a4a4dc89:protomaps/world.pmtiles";

export interface PmtilesRuntime {
  setup: () => void;
  dispose: () => void;
  addWorldMap: (
    map: MapLibreMap,
    url: string,
    theme: "light" | "dark",
  ) => Promise<void>;
}

const vectorLayerNames = (metadata: unknown): string[] => {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).vector_layers;
  const decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(decoded)) return [];
  return decoded
    .map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
};

const addLayers = (
  map: MapLibreMap,
  sourceId: string,
  sourceLayers: readonly string[],
  theme: "light" | "dark",
): void => {
  sourceLayers.forEach((sourceLayer, index) => {
    const color = theme === "dark" ? "#667481" : "#87939e";
    map.addLayer({
      id: `${sourceId}-${index}-fill`,
      type: "fill",
      source: sourceId,
      "source-layer": sourceLayer,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": color,
        "fill-opacity": theme === "dark" ? 0.08 : 0.12,
      },
    });
    map.addLayer({
      id: `${sourceId}-${index}-line`,
      type: "line",
      source: sourceId,
      "source-layer": sourceLayer,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": color, "line-width": 0.7, "line-opacity": 0.65 },
    });
    map.addLayer({
      id: `${sourceId}-${index}-point`,
      type: "circle",
      source: sourceId,
      "source-layer": sourceLayer,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 2,
        "circle-opacity": 0.5,
      },
    });
  });
};

export const createPmtilesRuntime = (): PmtilesRuntime => {
  const protocol = new Protocol();
  let installed = false;

  return {
    setup: () => {
      if (installed) return;
      maplibregl.setWorkerUrl(mapLibreWorkerUrl);
      maplibregl.addProtocol("pmtiles", protocol.tile);
      installed = true;
    },
    dispose: () => {
      if (!installed) return;
      maplibregl.removeProtocol("pmtiles");
      installed = false;
    },
    addWorldMap: async (map, url, theme) => {
      const archive = new PMTiles(url);
      protocol.add(archive);
      const metadata = await archive.getMetadata();
      await archive.getHeader();
      const sourceId = "constellation-world";
      map.addSource(sourceId, { type: "vector", url: `pmtiles://${url}` });
      addLayers(map, sourceId, vectorLayerNames(metadata), theme);
    },
  };
};
