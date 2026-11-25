export class EmulatorCleanupError extends Error {}

export const runAcceptanceMatrix = async (scenarios, report = console.log) => {
  const failed = []
  for (const { name, run } of scenarios) {
    report(`[Android matrix] START ${name}`)
    try {
      await run()
      report(`[Android matrix] PASS ${name}`)
    } catch (error) {
      report(`[Android matrix] FAIL ${name}`)
      // Do not serialize arbitrary subprocess exceptions or start a second owned
      // emulator if shutdown of the previous one was not confirmed.
      if (error instanceof EmulatorCleanupError) throw error
      failed.push(name)
    }
  }
  if (failed.length) {
    throw new Error(
      `[Android matrix] ${failed.length}/${scenarios.length} failed: ${failed.join(', ')}`,
    )
  }
  report(`[Android matrix] ${scenarios.length}/${scenarios.length} passed.`)
}
