import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { withTwoSources } from './fixtures/two-sources.ts'
import { openPeerFilter, openShareCreator } from './fixtures/peer-navigation.ts'

const capture = async (page: Page, name: string): Promise<void> => {
  await expect(page.locator('.location-map')).toHaveAttribute('data-rendered', 'true', {
    timeout: 60_000,
  })
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.maplibregl-canvas')).toBeVisible()
  await expect(page.locator('.location-map [role="alert"]')).toHaveCount(0)
  await expect(page.getByLabel('Share link')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Location share QR code' })).toHaveCount(0)
  await page.screenshot({
    path: path.join('.screenshots', `constellation-${name}.png`),
    animations: 'disabled',
  })
}

test('capture welcome, sharing choices, and two fictional followed locations', async ({
  browser,
  page,
  baseURL,
}) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error('Screenshots require the local app and relay.')
  await mkdir('.screenshots', { recursive: true })
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Privacy introduction' })).toBeVisible()
  await capture(page, 'welcome')
  await page.getByRole('button', { name: 'Got it' }).click()
  await openShareCreator(page)
  await expect(page.getByRole('button', { name: 'Create location link' })).toBeVisible()
  await capture(page, 'share')

  await withTwoSources(
    browser,
    baseURL,
    {
      viewport: { width: 430, height: 860 },
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    },
    async ({ viewer }) => {
      const following = await openPeerFilter(viewer, 'Viewing')
      const peers = following.locator('details.peer-list__item')
      await expect(peers).toHaveCount(2)
      for (const peer of await peers.all()) await peer.locator('.peer-list__summary').click()
      await expect(following.getByText(/Last location: not received/)).toHaveCount(0, {
        timeout: 30_000,
      })
      for (const name of ['River', 'Forest']) {
        await expect(
          following.locator('.peer-list__summary-name').filter({ hasText: name }),
        ).toBeVisible()
      }
      await peers.nth(0).locator('.peer-list__summary').click()
      await capture(viewer, 'following')
    },
  )
})
