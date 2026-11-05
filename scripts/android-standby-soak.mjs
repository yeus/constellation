// Test-runner option only. A long period of forced Android idle is not a
// substitute for an OEM device's real overnight power-management behavior.
export const parseStandbySoakMinutes = (args) => {
  const options = args.filter(
    (arg) => arg === '--standby-soak-minutes' || arg.startsWith('--standby-soak-minutes='),
  )
  if (options.length === 0) return null
  if (options.length > 1) throw new Error('Specify standby soak duration only once.')
  const literal = options[0].slice('--standby-soak-minutes='.length)
  const minutes = Number(literal)
  if (!literal || !Number.isFinite(minutes) || minutes <= 0 || minutes > 1_440) {
    throw new Error('Standby soak duration must be greater than 0 and at most 1440 minutes.')
  }
  return minutes
}
