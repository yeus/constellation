import { expect } from '@playwright/test'
import type { Browser, BrowserContextOptions, Page } from '@playwright/test'
import { openPeerList, openShareCreator } from './peer-navigation.ts'

const createNamedShare = async (page: Page, name: string): Promise<string> => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Center on my location' })).toBeVisible()
  await openShareCreator(page)
  await page.getByRole('textbox', { name: 'Share a name' }).fill(name)
  await page.getByRole('button', { name: 'Create location link' }).click()
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
  afterFirstFollow?: (viewer: Page) => Promise<void>,
): Promise<void> => {
  await viewer.goto(firstLink)
  await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
    timeout: 30_000,
  })
  const firstRequest = first.getByRole('region', { name: 'Viewer access request' })
  await expect(firstRequest).toBeVisible({ timeout: 30_000 })
  await firstRequest.getByRole('button', { name: 'Approve this device' }).click()
  await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1')
  await afterFirstFollow?.(viewer)
  const peerList = await openPeerList(viewer)
  await peerList.getByRole('button', { name: 'Add peer' }).click()
  await viewer.getByRole('textbox', { name: 'Paste location link' }).fill(secondLink)
  await viewer.getByRole('dialog').getByRole('button', { name: 'View location' }).click()
  const secondRequest = second.getByRole('region', { name: 'Viewer access request' })
  await expect(secondRequest).toBeVisible({ timeout: 30_000 })
  await secondRequest.getByRole('button', { name: 'Approve this device' }).click()
  await expect(viewer.locator('.dock-peers')).toContainText('Seeing 2', { timeout: 30_000 })
}

export const withTwoSources = async (
  browser: Browser,
  baseURL: string,
  viewerOptions: BrowserContextOptions,
  run: (pages: { first: Page; second: Page; viewer: Page }) => Promise<void>,
  options: {
    afterFirstFollow?: (viewer: Page) => Promise<void>
    sourceAccuracyMeters?: number
  } = {},
): Promise<void> => {
  const firstContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756, accuracy: options.sourceAccuracyMeters },
    permissions: ['geolocation'],
  })
  const secondContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 52.52, longitude: 13.405, accuracy: options.sourceAccuracyMeters },
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
    await followTwoSources(viewer, first, firstLink, second, secondLink, options.afterFirstFollow)
    await run({ first, second, viewer })
  } finally {
    await Promise.all([viewerContext.close(), secondContext.close(), firstContext.close()])
  }
}
