import { createSharingRuntime, type SharingRuntimeState } from '../../src/sharing/sharingRuntime.ts'
import { createBrowserLocationSource } from '../../src/location/browser.ts'
import { createShareDraft } from '../../src/shareDraft.ts'
import type { PrivateState } from '../../src/sharing/privateStore.ts'

export const probeDeviceComparison = async (requireViewerApproval: boolean) => {
  let sourceSaved: PrivateState | undefined, viewerSaved: PrivateState | undefined
  const sourceStore = {
    load: async () => sourceSaved,
    save: async (state: PrivateState) => {
      sourceSaved = structuredClone(state)
    },
  }
  const viewerStore = {
    load: async () => viewerSaved,
    save: async (state: PrivateState) => {
      viewerSaved = structuredClone(state)
    },
  }
  const source = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-source', geolocation: undefined }),
    undefined,
    sourceStore,
  )
  let viewer = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
    undefined,
    viewerStore,
  )
  let sourceState!: SharingRuntimeState, viewerState!: SharingRuntimeState
  source.subscribe((state) => {
    sourceState = state
  })
  viewer.subscribe((state) => {
    viewerState = state
  })
  try {
    const share = await source.createShare({ ...createShareDraft(), requireViewerApproval })
    await viewer.acceptShare(share.url)
    await viewer.startDeviceComparison(share.shareId)
    const senderCode = sourceState.deviceComparisons![0]!,
      viewerCode = viewerState.deviceComparisons![0]!
    const agreed =
      senderCode.letters === viewerCode.letters && /^[A-Z]{4}$/.test(viewerCode.letters)
    const automaticConfirmation = Boolean(senderCode.confirmedAt || viewerCode.confirmedAt)
    const noPrematureAdmission = requireViewerApproval
      ? sourceState.shares[0]!.viewerCount === 0 && viewerState.received.length === 0
      : sourceState.shares[0]!.viewerCount === 1
    await viewer.confirmDeviceComparison(share.shareId, viewerCode.challenge)
    await source.confirmDeviceComparison(share.shareId, senderCode.challenge)
    const manuallyConfirmed = Boolean(
      viewerSaved?.deviceComparisons?.[0]?.confirmedAt &&
        sourceSaved?.deviceComparisons?.[0]?.confirmedAt,
    )
    if (requireViewerApproval) await source.approveViewer(share.shareId, senderCode.peerId)
    await viewer.cancelDeviceComparison(share.shareId, viewerCode.challenge)
    const cancelled = viewerState.deviceComparisons!.length === 0
    await viewer.stop()
    viewer = createSharingRuntime(
      createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
      undefined,
      viewerStore,
    )
    viewer.subscribe((state) => {
      viewerState = state
    })
    await viewer.acceptShare(share.url)
    const budgetSurvivedRestart = viewerSaved?.comparisonBudgets?.[0]?.attempts === 1
    await viewer.startDeviceComparison(share.shareId)
    await viewer.startDeviceComparison(share.shareId)
    let deniedFourthAttempt = false
    try {
      await viewer.startDeviceComparison(share.shareId)
    } catch (error) {
      deniedFourthAttempt = error instanceof Error && /attempts exhausted/.test(error.message)
    }
    return {
      agreed,
      automaticConfirmation,
      manuallyConfirmed,
      cancelled,
      budgetSurvivedRestart,
      deniedFourthAttempt,
      noPrematureAdmission,
    }
  } finally {
    await viewer.stop()
    await source.stop()
  }
}
