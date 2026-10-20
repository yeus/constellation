import type { BrowserLocationSource } from '../location/browser.ts'
import type { PrivateStateStore } from './privateStore.ts'
import {
  createSharingHelpers,
  heartbeatSweep,
  unsubscribeLocationObservation,
  unsubscribeLocationState,
  type SharingContext,
} from './sharingHelpers.ts'
import { createSharingState } from './sharingState.ts'

export type { SharingContext } from './sharingHelpers.ts'

export const createSharingContext = (
  locationSource: BrowserLocationSource,
  shareBaseUrl: string,
  store: PrivateStateStore | undefined,
  returnShareReceiver: 'local' | 'external',
): SharingContext => {
  const state = createSharingState(locationSource, store)
  const ctx = {
    ...state,
    locationSource,
    shareBaseUrl,
    store,
    returnShareReceiver,
  } as SharingContext
  Object.assign(ctx, createSharingHelpers(ctx))
  ctx.heartbeatSweep = heartbeatSweep(ctx)
  ctx.unsubscribeLocationState = unsubscribeLocationState(ctx)
  ctx.unsubscribeLocationObservation = unsubscribeLocationObservation(ctx)
  return ctx
}
