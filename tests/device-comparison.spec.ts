import { expect, test } from '@playwright/test'

import { continueInBrowserIfOffered, openShareCreator } from './fixtures/peer-navigation.ts'
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

test('viewer and sender compare and independently confirm device letters through the UI', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error('A base URL is required.')
  const senderContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const sender = await senderContext.newPage()
    await sender.goto('/')
    await openShareCreator(sender)
    await sender.getByLabel(/Approve the recipient device before sharing/).uncheck()
    await sender.getByRole('button', { name: 'Create location link' }).click()
    const outgoing = sender.getByRole('dialog', { name: 'Share this QR code' })
    const url = await outgoing.getByLabel('Share link').inputValue({ timeout: 30_000 })
    const viewer = await viewerContext.newPage()
    await viewer.goto(url)
    await continueInBrowserIfOffered(viewer)
    await expect(outgoing).toHaveCount(0, { timeout: 30_000 })
    const preview = viewer.getByRole('region', { name: 'Location preview' })
    await preview.getByRole('button', { name: 'Compare device letters' }).click()
    const viewerDialog = viewer.getByRole('dialog', { name: 'Verify connection' })
    await viewerDialog.getByRole('button', { name: 'Start verification' }).click()
    const viewerLetters = viewerDialog.locator('.device-comparison-letters')
    await expect(viewerLetters).toHaveText(/^[A-Z]{4}$/, { timeout: 30_000 })

    const senderNotice = sender.getByRole('region', { name: 'Device verification ready' })
    await expect(senderNotice).toBeVisible({ timeout: 30_000 })
    await senderNotice.getByRole('button', { name: 'View verification' }).click()
    const senderDialog = sender.getByRole('dialog', { name: 'Verify connection' })
    await expect(senderDialog.locator('.device-comparison-letters')).toHaveText(
      await viewerLetters.innerText(),
    )
    await viewerDialog.getByRole('button', { name: 'Letters match' }).click()
    await expect(viewerDialog).toContainText('You confirmed matching letters on this device')
    await expect(senderDialog).not.toContainText('You confirmed matching letters on this device')
    await senderDialog.getByRole('button', { name: 'Letters match' }).click()
    await expect(senderDialog).toContainText('You confirmed matching letters on this device')
  } finally {
    await viewerContext.close()
    await senderContext.close()
  }
})
