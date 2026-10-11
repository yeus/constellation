import { expect, test } from '@playwright/test'

for (const requireApproval of [true, false]) {
  test(`device comparison over authenticated peers: ${requireApproval ? 'manual approval' : 'first-device claim'}`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.goto('/')
    const result = await page.evaluate(async (approval) => {
      const { probeDeviceComparison } = await import('../tests/fixtures/device-comparison-probe.ts')
      return probeDeviceComparison(approval)
    }, requireApproval)
    expect(result).toEqual({
      agreed: true,
      automaticConfirmation: false,
      manuallyConfirmed: true,
      cancelled: true,
      budgetSurvivedRestart: true,
      deniedFourthAttempt: true,
      noPrematureAdmission: true,
    })
  })
}
