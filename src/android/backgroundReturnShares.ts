import type { AndroidBackgroundStatus } from './backgroundSharing.ts'
import type { SharingRuntimeState } from '../sharing/sharingRuntime.ts'

export const receiveApprovedBackgroundReturns = async (
  status: Pick<AndroidBackgroundStatus, 'approvedReturnLinks' | 'returnOffers'>,
  receive: (offer: SharingRuntimeState['returnOffers'][number]) => Promise<void>,
  acknowledge: (offer: SharingRuntimeState['returnOffers'][number]) => Promise<void>,
): Promise<{ accepted: number; failed: number }> => {
  const approved = new Set(status.approvedReturnLinks ?? [])
  let accepted = 0
  let failed = 0
  for (const offer of status.returnOffers ?? []) {
    if (!approved.has(offer.shareId)) continue
    try {
      await receive(offer)
      await acknowledge(offer)
      accepted += 1
    } catch {
      failed += 1
    }
  }
  return { accepted, failed }
}
