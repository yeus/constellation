import { z } from 'zod'

export const SharingBehavior = z.object({
  publication: z.enum(['foreground', 'background']),
  battery: z.enum(['balanced', 'saver']),
  network: z.enum(['always', 'pause-when-metered']),
})
export type SharingBehavior = z.infer<typeof SharingBehavior>

export const defaultSharingBehavior = (isAndroid: boolean): SharingBehavior => ({
  publication: isAndroid ? 'background' : 'foreground',
  battery: 'balanced',
  network: 'always',
})
