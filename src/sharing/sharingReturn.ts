import type { SharingRuntime, SharingRuntimeState } from './sharingContracts.ts'
import { parseShareInvitation } from './shareLink.ts'

export const acceptReturnShare = async (
  runtime: Pick<SharingRuntime, 'acceptShare'>,
  offer: SharingRuntimeState['returnOffers'][number],
  isConnected: (shareId: string) => boolean,
): Promise<void> => {
  const capability = parseShareInvitation(offer.url)
  if (!isConnected(capability.shareId)) {
    await runtime.acceptShare(offer.url, { saved: true, returnOwnerPeerId: offer.ownerPeerId })
  }
  if (!isConnected(capability.shareId)) throw new Error('This return location link has ended.')
}
