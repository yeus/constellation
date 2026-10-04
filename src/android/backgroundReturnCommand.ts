import type { SharingRuntime } from '../sharing/sharingRuntime.ts'

export type BackgroundReturnCommand =
  | { type: 'approve-return-link'; requestId: string; shareId: string }
  | { type: 'dismiss-return-offer'; requestId: string; shareId: string; fingerprint: string }

export const executeBackgroundReturnCommand = async (
  runtime: Pick<SharingRuntime, 'approveReturnLink' | 'dismissReturnOffer'>,
  command: BackgroundReturnCommand,
  post: (result: { type: 'command-complete'; requestId: string; error?: string }) => void,
): Promise<void> => {
  try {
    if (command.type === 'approve-return-link') await runtime.approveReturnLink(command.shareId)
    else await runtime.dismissReturnOffer(command.shareId, command.fingerprint)
    post({ type: 'command-complete', requestId: command.requestId })
  } catch {
    post({
      type: 'command-complete',
      requestId: command.requestId,
      error: 'Could not save the return-sharing change.',
    })
  }
}
