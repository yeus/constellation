import type { SharingRuntime } from '../sharing/sharingRuntime.ts'

export type BackgroundReturnCommand =
  | { type: 'approve-return-link'; requestId: string; shareId: string }
  | { type: 'dismiss-return-offer'; requestId: string; shareId: string; fingerprint: string }
  | { type: 'dismiss-stopped-viewer'; requestId: string; shareId: string; peerId: string }

export const executeBackgroundReturnCommand = async (
  runtime: Pick<
    SharingRuntime,
    'approveReturnLink' | 'dismissReturnOffer' | 'dismissStoppedViewer'
  >,
  command: BackgroundReturnCommand,
  post: (result: { type: 'command-complete'; requestId: string; error?: string }) => void,
): Promise<void> => {
  try {
    if (command.type === 'approve-return-link') await runtime.approveReturnLink(command.shareId)
    else if (command.type === 'dismiss-return-offer')
      await runtime.dismissReturnOffer(command.shareId, command.fingerprint)
    else await runtime.dismissStoppedViewer(command.shareId, command.peerId)
    post({ type: 'command-complete', requestId: command.requestId })
  } catch {
    post({
      type: 'command-complete',
      requestId: command.requestId,
      error:
        command.type === 'dismiss-stopped-viewer'
          ? 'Could not save the stop notice.'
          : 'Could not save the return-sharing change.',
    })
  }
}
