import { z } from 'zod'

export const SharingBehavior = z.object({
  publication: z.enum(['foreground', 'background']),
  battery: z.enum(['balanced', 'saver']),
  network: z.enum(['always', 'pause-when-metered']),
  /** Applies to Android native background acquisition, not transmitted disclosure precision. */
  locationProvider: z.enum(['automatic', 'network-only']).optional(),
  /** Sender controls whether authenticated viewers may temporarily boost tracking. */
  activeViewingBoost: z.boolean().optional(),
})
export type SharingBehavior = z.infer<typeof SharingBehavior>

export const defaultSharingBehavior = (isAndroid: boolean): SharingBehavior => ({
  publication: isAndroid ? 'background' : 'foreground',
  battery: isAndroid ? 'saver' : 'balanced',
  network: 'always',
  locationProvider: 'automatic',
  activeViewingBoost: true,
})
