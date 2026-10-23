import { z } from 'zod'

/** A map viewport is location-bearing private state; never persist it in localStorage. */
export const MapCameraSchema = z.object({
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-85).max(85),
  zoom: z.number().finite().min(0).max(22),
})
export type MapCamera = z.infer<typeof MapCameraSchema>

export const isDefaultMapCamera = (camera: MapCamera): boolean =>
  camera.longitude === 0 && camera.latitude === 20 && camera.zoom === 1.5
