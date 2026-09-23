import { expect, test } from '@playwright/test'

test('configures a privacy-preserving location share', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('Not sharing')).toBeVisible()
  await page.getByRole('button', { name: 'Share location' }).click()

  const approximate = page.getByRole('button', { name: /Approximate/ })
  const oneHour = page.getByRole('button', { name: '1 hour' })
  const oneViewer = page.getByRole('button', { name: '1', exact: true })

  await expect(approximate).toHaveAttribute('aria-pressed', 'true')
  await expect(oneHour).toHaveAttribute('aria-pressed', 'true')
  await expect(oneViewer).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Until stopped' }).click()
  await expect(page.getByRole('button', { name: 'Create private link' })).toBeDisabled()

  await page.getByRole('checkbox').check()
  await expect(page.getByRole('button', { name: 'Create private link' })).toBeEnabled()
})

test('follows live system light and dark preferences', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Share location' }).click()

  const sheet = page.getByRole('dialog')
  await expect(sheet).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')

  await page.emulateMedia({ colorScheme: 'dark' })

  await expect(sheet).toHaveCSS('background-color', 'rgb(22, 29, 39)')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
})
