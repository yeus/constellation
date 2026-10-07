import { expect, test, type Page } from '@playwright/test'

const openSuite = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
  await page.getByRole('button', { name: 'Run sharing diagnostics' }).click()
}

const runCase = async (page: Page, name: string) => {
  await page
    .getByRole('group', { name, exact: true })
    .getByRole('button', { name: 'Run test', exact: true })
    .click()
}

test('runs the suite with explicit skipped results and a safe copyable report', async ({
  page,
}) => {
  await openSuite(page)
  await page.getByRole('button', { name: 'Run all diagnostics', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Sharing diagnostics', exact: true }).getByRole('status'),
  ).toContainText('Finished', { timeout: 30_000 })
  const report = JSON.parse(await page.getByLabel('Diagnostic results').inputValue())
  expect(report.summary.failed).toBe(0)
  expect(report.summary.passed).toBe(3)
  expect(report.summary.skipped).toBe(4)
  expect(report.results.every((result: { id: string }) => result.id)).toBe(true)
  expect(JSON.stringify(report)).not.toMatch(/#share=|\/ip4\/|latitude|longitude|peerId|https:\/\//)
  await page.getByRole('button', { name: 'Back to diagnostics' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sharing 0', exact: true })).toBeVisible()
})

test('cancels a waiting pair and closes its temporary session', async ({ page }) => {
  test.setTimeout(90_000)
  await openSuite(page)
  await page.getByLabel('Category', { exact: true }).selectOption('paired')
  await page.getByLabel('Pairing role').selectOption('host')
  await runCase(page, 'Two-way sharing and revocation')
  await expect(page.getByLabel('Diagnostic pairing link')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Sharing diagnostics', exact: true }).getByRole('status'),
  ).toContainText('Cancelled', { timeout: 30_000 })
  await expect(page.getByLabel('Diagnostic pairing link')).toHaveCount(0)
  const report = JSON.parse(await page.getByLabel('Diagnostic results').inputValue())
  expect(report.summary.cancelled).toBe(1)
  expect(report.summary.passed).toBe(0)
})

for (const scenario of ['Two-way sharing and revocation', 'Link expiry', 'Batch fresh link']) {
  const batch = scenario === 'Batch fresh link'
  const caseName = batch ? 'Two-way sharing and revocation' : scenario
  test(`independent devices verify ${scenario.toLowerCase()} through real sharing`, async ({
    browser,
    baseURL,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'The independent-pair flow runs once on desktop; suite UI also runs on mobile.',
    )
    test.setTimeout(caseName === 'Link expiry' ? 100_000 : 60_000)
    const firstContext = await browser.newContext({ baseURL })
    const secondContext = await browser.newContext({ baseURL })
    try {
      const source = await firstContext.newPage()
      const viewer = await secondContext.newPage()
      await openSuite(source)
      await openSuite(viewer)
      for (const page of [source, viewer])
        await page.getByLabel('Category', { exact: true }).selectOption('paired')
      await source.getByLabel('Pairing role').selectOption('host')
      await runCase(source, caseName)
      const url = await source.getByLabel('Diagnostic pairing link').inputValue({ timeout: 30_000 })
      await viewer.getByLabel('Pairing role').selectOption('join')
      await viewer.getByLabel('Diagnostic partner link').fill(url)
      if (batch) {
        await viewer.getByRole('checkbox', { name: /Include guided/ }).check()
        await viewer.getByRole('button', { name: 'Run selected category', exact: true }).click()
        await expect(
          viewer
            .getByRole('dialog', { name: 'Sharing diagnostics', exact: true })
            .getByRole('status'),
        ).toContainText('fresh link', { timeout: 30_000 })
        await expect(viewer.getByLabel('Diagnostic partner link')).toBeEnabled()
        await viewer.getByRole('button', { name: 'Cancel run', exact: true }).click()
      } else await runCase(viewer, caseName)
      for (const page of [viewer, source]) {
        await expect(
          page
            .getByRole('dialog', { name: 'Sharing diagnostics', exact: true })
            .getByRole('status'),
        ).toContainText(batch && page === viewer ? 'Cancelled' : 'Finished', {
          timeout: caseName === 'Link expiry' ? 80_000 : 30_000,
        })
        const report = JSON.parse(await page.getByLabel('Diagnostic results').inputValue())
        if (report.summary.passed !== 1 || report.summary.failed !== 0)
          throw new Error(`Diagnostic report: ${JSON.stringify(report)}`)
        expect(report.summary.passed).toBe(1)
        expect(report.summary.failed).toBe(0)
        if (batch && page === viewer) expect(report.summary.cancelled).toBe(1)
        expect(report.results[0].transports.length).toBeGreaterThan(0)
        expect(JSON.stringify(report)).not.toMatch(/#share=|\/ip4\/|latitude|longitude|peerId/)
      }
    } finally {
      await firstContext.close()
      await secondContext.close()
    }
  })
}
