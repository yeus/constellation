export const peerInitials = (displayName: string): string => {
  // Adapted from dev.taskyon.space's src/modules/auth/supabase.ts
  // getInitialsFromEmail: first letters of two words, or first two of one.
  // Use the displayed name (never an email) and retain non-Latin letters.
  const words = displayName
    .normalize('NFC')
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const initials =
    words.length > 1
      ? words.slice(0, 2).map((word) => Array.from(word)[0] ?? '')
      : Array.from(words[0] ?? '').slice(0, 2)
  return initials.join('').toUpperCase() || '•'
}
