import { parseShareInvitation } from '../sharing/shareLink.ts'

export const invitationFromSharedText = (text: string): string | undefined => {
  if (text.length > 8192) return undefined
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[.,;)\]]+$/, '')
    try {
      parseShareInvitation(candidate)
      return candidate
    } catch {
      // Keep looking for a valid invitation in the shared message.
    }
  }
  return undefined
}
