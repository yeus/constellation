import { z } from 'zod'
import { parseLocationObservationV1 } from '../location/locationObservation.ts'
import type { BackgroundViewerSnapshot } from './backgroundViewer.ts'

const ReceiverOwner = z.enum(['activity', 'service'])
const ReceiverSnapshot = z.object({
  owner: ReceiverOwner,
  generation: z.number().int().nonnegative(),
  status: z.unknown().nullable().optional(),
})
const ViewerStatus = z.object({
  generation: z.number().int().positive(),
  following: z
    .array(
      z.object({
        shareId: z.string().min(1),
        status: z.enum([
          'live',
          'delayed',
          'stale',
          'expired',
          'revoked',
          'unavailable',
          'approval-pending',
          'denied',
        ]),
        connected: z.boolean(),
        updatesReceived: z.number().int().nonnegative(),
        lastLocationAt: z.number().optional(),
      }),
    )
    .max(128),
  received: z
    .array(
      z.object({
        shareId: z.string().min(1),
        state: z.enum(['live', 'delayed', 'stale']),
        observation: z.unknown(),
      }),
    )
    .max(128),
})
const parseViewerStatus = (value: unknown, generation: number): BackgroundViewerSnapshot | null => {
  if (value == null) return null
  const parsed = ViewerStatus.parse(value)
  if (parsed.generation !== generation) throw new Error('Stale receiver status.')
  return {
    generation: parsed.generation,
    following: parsed.following,
    received: parsed.received.map(({ shareId, state, observation }) => ({
      shareId,
      state,
      observation: parseLocationObservationV1(observation),
    })),
  }
}
export type ReceiverOwner = z.infer<typeof ReceiverOwner>
export interface AndroidReceiverOwnership {
  owner: ReceiverOwner
  generation: number
  status?: BackgroundViewerSnapshot | null
}

export interface AndroidReceiverDependencies {
  readonly isAndroid: boolean
  readonly invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

export const createAndroidBackgroundReceiver = ({
  isAndroid,
  invoke,
}: AndroidReceiverDependencies) =>
  !isAndroid
    ? undefined
    : {
        ownership: async (): Promise<AndroidReceiverOwnership> => {
          const response = ReceiverSnapshot.parse(await invoke('android_receiver_ownership'))
          return {
            owner: response.owner,
            generation: response.generation,
            status:
              response.owner === 'service'
                ? parseViewerStatus(response.status, response.generation)
                : null,
          }
        },
        start: (generation: number) =>
          invoke('android_start_background_receiver', { generation }).then(() => undefined),
        stop: (generation: number) =>
          invoke('android_stop_background_receiver', { generation }).then(() => undefined),
      }
