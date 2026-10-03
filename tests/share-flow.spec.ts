import { expect, test } from '@playwright/test'

import { createShareInvitation } from '../src/sharing/shareLink.ts'

test('rejects an expired pasted link before opening a viewer session', async ({ page }) => {
  const expired = createShareInvitation({
    baseUrl: 'http://127.0.0.1:4173/',
    sourcePeerId: 'synthetic-source',
    addresses: ['/dns4/relay.example/tcp/443/wss/p2p/synthetic'],
    expiresAt: 1,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Follow a link' }).click()
  await page.getByLabel('Paste location link').fill(expired.url)
  await page.getByRole('dialog').getByRole('button', { name: 'View location' }).click()
  await expect(page.locator('.toast')).toContainText(/not a valid location link|expired/i)
  await expect(page.getByText('Seeing 1')).toHaveCount(0)
})

test('introduces encrypted P2P sharing and keeps the note dismissed', async ({ page }) => {
  await page.goto('/')

  const introduction = page.getByRole('region', { name: 'Privacy introduction' })
  await expect(introduction).toContainText('end-to-end encrypted')
  await expect(introduction).toContainText('no central location history')
  await expect(page.getByRole('button', { name: 'Share location' })).toBeVisible()

  await introduction.getByRole('button', { name: 'Got it' }).click()
  await page.reload()
  await expect(introduction).toHaveCount(0)

  await page.getByRole('button', { name: 'Share location' }).click()
  await expect(page.getByRole('dialog')).toContainText(/end-to-end encrypted/i)
  await expect(page.getByRole('dialog')).toContainText(/no central location history/i)
})

test('offers direct app downloads to Android and Linux web visitors', async ({ browser }) => {
  const releasesUrl = 'https://github.com/yeus/constellation/releases/latest'
  const platforms = [
    {
      name: 'Android',
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
      expectsHint: true,
    },
    {
      name: 'Linux',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      expectsHint: true,
    },
    {
      name: 'Windows',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      expectsHint: false,
    },
  ]

  for (const { name, userAgent, expectsHint } of platforms) {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:4173',
      userAgent,
    })
    const page = await context.newPage()
    await page.goto('/')

    const introduction = page.getByRole('region', { name: 'Privacy introduction' })
    const downloadLink = introduction.getByRole('link', { name: 'Get Android and Linux apps' })
    if (expectsHint) {
      await expect(introduction, name).toContainText(
        'Android app can keep sharing in the background',
      )
      await expect(downloadLink).toHaveAttribute('href', releasesUrl)
    } else {
      await expect(downloadLink, name).toHaveCount(0)
    }

    await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(page.getByRole('link', { name: 'GitHub project' })).toHaveAttribute(
      'href',
      'https://github.com/yeus/constellation',
    )
    await expect(page.getByRole('link', { name: 'Latest release' })).toHaveAttribute(
      'href',
      releasesUrl,
    )
    await context.close()
  }
})

test('explains relay and local-storage limits in About', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Privacy and licenses' }).click()

  const about = page.getByRole('dialog', { name: 'Constellation' })
  await expect(about).toContainText('decentralized')
  await expect(about).toContainText('relays cannot read location content')
  await expect(about).toContainText('configured relay for reachability')
  await expect(about).toContainText('connection metadata')
  await expect(about).toContainText('may reveal the area you view')
  await expect(about).toContainText('private share settings')
  await expect(about).toContainText('does not make you anonymous')
})

test('reports an invalid share fragment without exposing it', async ({ page }) => {
  await page.goto('/#share=malformed-synthetic-capability')
  await expect(page.getByRole('status').last()).toContainText('invalid or expired')
  await expect(page.getByRole('status').last()).not.toContainText('malformed-synthetic-capability')
})

test('copies bounded session diagnostics from the top-left menu', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          ;(window as typeof window & { copiedDiagnostics?: string }).copiedDiagnostics = value
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Copy logs' }).click()

  const copied = await page.evaluate(
    () => (window as typeof window & { copiedDiagnostics?: string }).copiedDiagnostics,
  )
  expect(copied).toContain('Constellation session logs')
  expect(copied).toContain('app.started')
  await expect(page.getByRole('status').last()).toContainText('Copied logs to clipboard')
})

test('explains when the clipboard cannot accept logs', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Synthetic clipboard failure.')
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Copy logs' }).click()

  await expect(page.getByRole('status').last()).toContainText(
    'Could not copy logs to the clipboard',
  )
})

test('configures a privacy-preserving location share', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Sharing 0' })).toBeVisible()
  await page.getByRole('button', { name: 'Share location' }).click()

  const approximate = page.getByRole('button', { name: /Approximate/ })
  const veryCoarse = page.getByRole('button', { name: /Very coarse/ })
  const oneHour = page.getByRole('button', { name: '1 hour' })
  const oneViewer = page.getByRole('button', { name: '1', exact: true })

  await expect(approximate).toHaveAttribute('aria-pressed', 'true')
  await expect(veryCoarse).toHaveAttribute('aria-pressed', 'false')
  await veryCoarse.click()
  await expect(veryCoarse).toHaveAttribute('aria-pressed', 'true')
  await expect(approximate).toHaveAttribute('aria-pressed', 'false')
  if (test.info().project.name === 'mobile') {
    const action = await page.getByRole('button', { name: 'Create private link' }).boundingBox()
    expect(action).not.toBeNull()
    expect(action!.y + action!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  }
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

test('shows local position without publishing and offers link paste', async ({ page }) => {
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 52.52, longitude: 13.405 })
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Center on my location' })).toBeVisible()
  await expect(page.getByText('Sharing 0')).toBeVisible()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Follow a link' }).click()
  await expect(page.getByRole('textbox', { name: 'Paste location link' })).toBeVisible()
})

test('lets the sender optionally include a name and choose foreground sharing', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Share location' }).click()

  await page.getByRole('textbox', { name: 'Share a name' }).fill('River')
  await expect(page.getByRole('button', { name: 'While app is open' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Create private link' })).toBeEnabled()
})
