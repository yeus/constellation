import { expect } from '@playwright/test'
import type { Browser, BrowserContextOptions, Page } from '@playwright/test'
import {
  continueInBrowserIfOffered,
  openPeerList,
  openShareCreator,
  pasteLocationLink,
} from './peer-navigation.ts'

const createNamedShare = async (page: Page, name: string): Promise<string> => {
  await page.goto('/')
  await expect(page.locator('button.recenter-button')).toBeVisible()
  await openShareCreator(page)
  await page.getByRole('textbox', { name: 'Name to share' }).fill(name)
  await page.getByRole('button', { name: 'Create location link' }).click()
  const url = await page.getByLabel('Share link').inputValue({ timeout: 30_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  return url
}

const expectSecureComparison = async (sender: Page, viewer: Page): Promise<void> => {
  const request = sender.getByRole('region', { name: 'Viewer access request' })
  try {
    await expect(request.locator('.device-comparison-letters')).toHaveText(/^[A-Z]{4}$/, {
      timeout: 30_000,
    })
  } catch (error) {
    // Capture only categorical UI state; no nicknames, fingerprints, addresses or keys.
    const receiver = await viewer
      .getByRole('region', { name: 'Location preview' })
      .evaluate((element) => ({
        comparisonVisible: Boolean(element.querySelector('.device-comparison-letters')),
        pending: element.textContent?.includes('Establishing secure comparison') === true,
        errorVisible: Boolean(element.querySelector('[role="alert"]')),
        retryVisible: [...element.querySelectorAll('button')].some((button) =>
          button.textContent?.includes('Retry comparison'),
        ),
      }))
      .catch(() => ({ unavailable: true }))
    const source = await request
      .evaluate((element) => ({
        comparisonVisible: Boolean(element.querySelector('.device-comparison-letters')),
        pending: element.textContent?.includes('Waiting for the viewer') === true,
      }))
      .catch(() => ({ unavailable: true }))
    throw new Error(`Secure comparison failed: ${JSON.stringify({ receiver, source })}`, {
      cause: error,
    })
  }
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
  await continueInBrowserIfOffered(viewer)
  const firstRequest = first.getByRole('region', { name: 'Viewer access request' })
  await expectSecureComparison(first, viewer)
  await firstRequest.getByRole('button', { name: 'Approve this device' }).click()
  await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1')
  await afterFirstFollow?.(viewer)
  const peerList = await openPeerList(viewer)
  await peerList.getByRole('button', { name: 'Add peer' }).click()
  await pasteLocationLink(viewer, secondLink)
  await continueInBrowserIfOffered(viewer)
  const secondRequest = second.getByRole('region', { name: 'Viewer access request' })
  await expectSecureComparison(second, viewer)
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
    // Avoid overlapping map/WebGL startup; the test still runs both live sources together.
    const firstLink = await createNamedShare(first, 'River')
    const secondLink = await createNamedShare(second, 'Forest')
    await followTwoSources(viewer, first, firstLink, second, secondLink, options.afterFirstFollow)
    await run({ first, second, viewer })
  } finally {
    await Promise.all([viewerContext.close(), secondContext.close(), firstContext.close()])
  }
}
