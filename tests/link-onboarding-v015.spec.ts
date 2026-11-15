import { expect, test } from '@playwright/test'

import { openShareCreator } from './fixtures/peer-navigation.ts'

test('single-viewer link requires consent and compares fresh letters before location admission', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const sender = await sourceContext.newPage()
    const viewer = await viewerContext.newPage()
    await sender.goto('/')
    await openShareCreator(sender)
    await sender.getByRole('button', { name: 'Create location link' }).click()
    const url = await sender.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await sender.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await viewer.goto(url)
    const intro = viewer.getByRole('dialog', { name: 'Location link introduction' })
    await expect(intro).toBeVisible()
    await expect(intro).toContainText('Your location will not be shared')
    await expect(intro).toContainText('four letters')
    await expect(sender.getByRole('region', { name: 'Viewer access request' })).toHaveCount(0)
    await expect(viewer.getByRole('region', { name: 'Location preview' })).toHaveCount(0)

    await intro.getByRole('button', { name: 'See location' }).click()
    const preview = viewer.getByRole('region', { name: 'Location preview' })
    const approval = sender.getByRole('region', { name: 'Viewer access request' })
    await expect(preview).toContainText('Waiting for sender approval', { timeout: 30_000 })
    await expect(approval).toBeVisible({ timeout: 30_000 })
    // The automatic comparison may already have completed when the approval UI appears.
    const viewerLetters = preview.locator('.device-comparison-letters')
    await expect(viewerLetters).toHaveText(/^[A-Z]{4}$/, { timeout: 30_000 })
    const senderLetters = approval.locator('.device-comparison-letters')
    await expect(senderLetters).toHaveText(await viewerLetters.innerText(), { timeout: 30_000 })
    await expect(approval.getByRole('button', { name: 'Approve this device' })).toBeEnabled()
    await expect(preview.getByRole('button', { name: 'Add peer' })).toHaveCount(0)

    await approval.getByRole('button', { name: 'Approve this device' }).click()
    await expect(preview.getByRole('button', { name: 'Add peer' })).toBeVisible({ timeout: 30_000 })
    await expect(viewer.locator('.map-surface')).toBeVisible()
    await preview.getByRole('button', { name: 'Add peer' }).click()
    const saved = viewer.getByRole('region', { name: 'Peer added' })
    await expect(saved).toBeVisible()
    await expect(saved.getByRole('button', { name: 'Share back' })).toBeVisible()
    await saved.getByRole('button', { name: 'Not now' }).click()
    await expect(viewer.getByRole('region', { name: 'Peer added' })).toHaveCount(0)
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('every new link opening presents consent; cancel never redeems, multi-viewer share opens map', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000)
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const sender = await sourceContext.newPage()
    const viewer = await viewerContext.newPage()
    await sender.goto('/')
    await openShareCreator(sender)
    await sender.getByRole('button', { name: '10', exact: true }).click()
    await sender.getByRole('button', { name: 'Create location link' }).click()
    const url = await sender.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await sender.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await viewer.goto(url)
    const intro = viewer.getByRole('dialog', { name: 'Location link introduction' })
    await expect(intro).toBeVisible()
    await intro.getByRole('button', { name: 'Cancel' }).click()
    await expect(intro).toHaveCount(0)
    await expect(viewer.getByRole('region', { name: 'Location preview' })).toHaveCount(0)
    await expect(sender.getByRole('region', { name: 'Viewer access request' })).toHaveCount(0)

    await viewer.goto(url)
    await expect(intro).toBeVisible()
    await intro.getByRole('button', { name: 'See location' }).click()
    const preview = viewer.getByRole('region', { name: 'Location preview' })
    await expect(preview.getByRole('button', { name: 'Add peer' })).toBeVisible({ timeout: 30_000 })
    await expect(preview.locator('.device-comparison-letters')).toHaveCount(0)
    await preview.getByRole('button', { name: 'Not now' }).click()
    await expect(preview).toHaveCount(0)

    // Reopening the same link also requires explicit consent.
    await viewer.goto(url)
    await expect(intro).toBeVisible()
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('until stopped multi-viewer QR lets multiple recipients view after consent without sender approval', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const firstViewerContext = await browser.newContext({ baseURL })
  const secondViewerContext = await browser.newContext({ baseURL })
  try {
    const sender = await sourceContext.newPage()
    await sender.goto('/')
    await openShareCreator(sender)
    const form = sender.getByRole('dialog', { name: 'Share your location' })
    await form.getByRole('button', { name: 'No limit', exact: true }).click()
    await form.getByRole('button', { name: 'Until stopped' }).click()
    await expect(form).toContainText('New devices can join until you stop sharing.')
    await expect(form.getByText('Approve the recipient device before sharing')).toHaveCount(0)
    await form
      .getByRole('checkbox', { name: 'I understand this link stays active until I stop it.' })
      .check()
    await form.getByRole('button', { name: 'Create location link' }).click()
    const url = await sender.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await sender.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    for (const context of [firstViewerContext, secondViewerContext]) {
      const viewer = await context.newPage()
      await viewer.goto(url)
      const intro = viewer.getByRole('dialog', { name: 'Location link introduction' })
      await expect(intro).toContainText('Your location will not be shared')
      await intro.getByRole('button', { name: 'See location' }).click()
      const preview = viewer.getByRole('region', { name: 'Location preview' })
      await expect(preview.getByRole('button', { name: 'Add peer' })).toBeVisible({
        timeout: 30_000,
      })
      await expect(preview.locator('.device-comparison-letters')).toHaveCount(0)
      await expect(sender.getByRole('region', { name: 'Viewer access request' })).toHaveCount(0)
    }
  } finally {
    await secondViewerContext.close()
    await firstViewerContext.close()
    await sourceContext.close()
  }
})
