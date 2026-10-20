import type { SharingRuntime } from './sharingContracts.ts'
import type { SharingContext } from './sharingContext.ts'
import { createLifecycleApi } from './sharingLifecycleApi.ts'
import { createSourceApi } from './sharingSourceApi.ts'
import { createViewerApi } from './sharingViewerApi.ts'

export const createSharingApi = (ctx: SharingContext): SharingRuntime => ({
  ...createSourceApi(ctx),
  ...createViewerApi(ctx),
  ...createLifecycleApi(ctx),
})
