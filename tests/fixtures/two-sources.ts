import { expect } from '@playwright/test'
import type { Browser, BrowserContextOptions, Page } from '@playwright/test'

const createNamedShare = async (page: Page, name: string): Promise<string> => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Center on my location' })).toBeVisible()
  await page.getByRole('button', { name: 'Share location' }).click()
  await page.getByRole('textbox', { name: 'Share a name' }).fill(name)
  await page.getByRole('button', { name: 'Create private link' }).click()
  const url = await page.getByLabel('Share link').inputValue({ timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  return url
}

const followTwoSources = async (
  viewer: Page,
  first: Page,
  firstLink: string,
  second: Page,
  secondLink: string,
): Promise<void> => {
  await viewer.goto(firstLink)
  await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
    timeout: 30_000,
  })
  const firstRequest = first.getByRole('region', { name: 'Viewer access request' })
  await expect(firstRequest).toBeVisible({ timeout: 30_000 })
  await firstRequest.getByRole('button', { name: 'Approve this device' }).click()
  await expect(viewer.getByText('Seeing 1')).toBeVisible()
  await viewer.getByRole('button', { name: 'Open menu' }).click()
  await viewer.getByRole('button', { name: 'Follow a link' }).click()
  await viewer.getByRole('textbox', { name: 'Paste location link' }).fill(secondLink)
  await viewer.getByRole('dialog').getByRole('button', { name: 'View location' }).click()
  const secondRequest = second.getByRole('region', { name: 'Viewer access request' })
  await expect(secondRequest).toBeVisible({ timeout: 30_000 })
  await secondRequest.getByRole('button', { name: 'Approve this device' }).click()
  await expect(viewer.getByText('Seeing 2')).toBeVisible({ timeout: 30_000 })
}

export const withTwoSources = async (
  browser: Browser,
  baseURL: string,
  viewerOptions: BrowserContextOptions,
  run: (pages: { first: Page; second: Page; viewer: Page }) => Promise<void>,
): Promise<void> => {
  const firstContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const secondContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: ['geolocation'],
  })
  const viewerContext = await browser.newContext({ baseURL, ...viewerOptions })
  try {
    const first = await firstContext.newPage()
    const second = await secondContext.newPage()
    const viewer = await viewerContext.newPage()
    const [firstLink, secondLink] = await Promise.all([
      createNamedShare(first, 'River'),
      createNamedShare(second, 'Forest'),
    ])
    await followTwoSources(viewer, first, firstLink, second, secondLink)
    await run({ first, second, viewer })
  } finally {
    await Promise.all([viewerContext.close(), secondContext.close(), firstContext.close()])
  }
}
