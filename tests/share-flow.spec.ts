import { expect, test } from '@playwright/test'

import { createShareInvitation } from '../src/sharing/shareLink.ts'
import {
  expandPeerDetails,
  openPeerList,
  openShareCreator,
  pasteLocationLink,
  setTestClipboardText,
} from './fixtures/peer-navigation.ts'

test('rejects an expired pasted link before opening a viewer session', async ({ page }) => {
  const expired = await createShareInvitation({
    baseUrl: 'http://127.0.0.1:4173/',
    sourcePeerId: 'synthetic-source',
    addresses: ['/dns4/relay.example/tcp/443/wss/p2p/synthetic'],
    expiresAt: 1,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
  })
  await page.goto('/')
  const peerList = await openPeerList(page)
  await peerList.getByRole('button', { name: 'Add peer' }).click()
  await pasteLocationLink(page, expired.url)
  const follow = page.getByRole('dialog', { name: 'Follow a location' })
  await expect(follow.getByRole('alert')).toContainText(/expired/i)
  await expect(page.getByText('Seeing 1')).toHaveCount(0)
})

test('introduces encrypted P2P sharing and keeps the note dismissed', async ({ page }) => {
  await page.goto('/')

  const introduction = page.getByRole('region', { name: 'Privacy introduction' })
  await expect(introduction).toContainText('end-to-end encrypted')
  await expect(introduction).toContainText('no central location history')
  await expect(introduction.getByRole('link', { name: 'More information' })).toHaveAttribute(
    'href',
    'https://github.com/yeus/constellation#how-constellation-protects-your-privacy',
  )
  await expect(page.locator('.dock-peers')).toBeVisible()

  await introduction.getByRole('button', { name: 'Got it' }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(introduction).toHaveCount(0)

  await openShareCreator(page)
  await expect(page.getByRole('dialog')).toContainText(/end-to-end encrypted/i)
  await expect(page.getByRole('dialog')).toContainText(/no central location storage/i)
})

test('share setup keeps link choices on one page and explains privacy without losing the draft', async ({
  page,
}) => {
  await page.goto('/')
  await openShareCreator(page)
  const form = page.getByRole('dialog', { name: 'Share your location' })
  await expect(
    form.getByRole('button', { name: /While app is open|In background|Battery saver|Balanced/ }),
  ).toHaveCount(0)
  await expect(
    form.getByRole('button', { name: 'Create location link', exact: true }),
  ).toBeVisible()
  await expect(form.getByRole('checkbox', { name: 'Share a name' })).toHaveCount(0)
  await expect(form.getByRole('textbox', { name: 'Name to share' })).toHaveValue(
    /^[A-Z][a-z]+ [A-Z][a-z]+$/,
  )
  await form.getByRole('textbox', { name: 'Name to share' }).fill('Synthetic River')
  await form.getByRole('button', { name: 'City 20 km radius', exact: true }).click()
  await form.getByRole('button', { name: '8 hours', exact: true }).click()
  await form.getByRole('button', { name: 'No limit', exact: true }).click()
  await expect(
    form.getByRole('button', { name: 'No limit', exact: true }).locator('svg'),
  ).toHaveCount(1)
  await form.getByRole('button', { name: 'More info', exact: true }).click()
  const privacy = page.getByRole('dialog', { name: 'Your location stays between devices' })
  await expect(privacy).toContainText('no location history on its servers')
  await expect(privacy).toContainText('approximate area')
  await expect(privacy).toContainText('receiver can still save')
  await expect(form).not.toBeVisible()
  await page.keyboard.press('Escape')
  await expect(form.getByRole('button', { name: 'More info', exact: true })).toBeFocused()
  await expect(form.getByRole('textbox', { name: 'Name to share' })).toHaveValue('Synthetic River')
  await expect(form.getByRole('button', { name: '8 hours', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(form.getByRole('button', { name: 'No limit', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(form).toContainText('End-to-end encrypted. No central location storage.')
})

test('precision options keep their order and explain each choice without losing the draft', async ({
  page,
}) => {
  await page.goto('/')
  await openShareCreator(page)
  const form = page.getByRole('dialog', { name: 'Share your location' })
  const options = form.locator('.choice-grid').first().getByRole('button')
  await expect(options).toHaveCount(3)
  await expect(options.nth(0)).toContainText('Exact')
  await expect(options.nth(0)).toContainText('No added blurring')
  await expect(options.nth(1)).toContainText('Neighbourhood')
  await expect(options.nth(1)).toContainText('1 km radius')
  await expect(options.nth(2)).toContainText('City')
  await expect(options.nth(2)).toContainText('20 km radius')
  await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true')

  await form.getByRole('button', { name: 'Explain precision choices' }).click()
  const help = page.getByRole('dialog', { name: 'Precision choices' })
  await expect(help).toBeVisible()
  await expect(help).toContainText('device-reported position')
  await expect(help).toContainText('1 km radius')
  await expect(help).toContainText('20 km radius')
  await expect(help).toContainText('promises anonymity')
  await expect(form).not.toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(form.getByRole('button', { name: 'Explain precision choices' })).toBeFocused()
  await expect(options.nth(1)).toHaveAttribute('aria-pressed', 'true')
})

test('browser retains the requested background mode but safely applies a foreground fallback', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const background = settings.getByRole('button', { name: /In background/ })
  await expect(background).toBeEnabled()
  await background.click()
  await expect(background).toHaveAttribute('aria-pressed', 'true')
  await expect(settings).toContainText('Background location is available only in the Android app')
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
        const { loadLocalSharingPreference } = await import('../src/sharing/sharingPreference.ts')
        return {
          requested: loadLocalSharingPreference(window.localStorage)?.publication,
          effective: (await createBrowserPrivateStore().load())?.sharingBehavior?.publication,
        }
      }),
    )
    .toEqual({ requested: 'background', effective: 'foreground' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open menu', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(background).toHaveAttribute('aria-pressed', 'true')
  await expect(settings).toContainText('Effective fallback')
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

    await page.evaluate(() => {
      window.open = (url) => {
        document.documentElement.dataset.openedProjectUrl = String(url ?? '')
        return window
      }
    })
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('button', { name: 'GitHub project' }).click()
    await expect(page.locator('html')).toHaveAttribute(
      'data-opened-project-url',
      'https://github.com/yeus/constellation',
    )
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('button', { name: 'Latest release' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-opened-project-url', releasesUrl)
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

test('shares sanitized session logs as a downloadable text file without the clipboard', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Share logs as file' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^constellation-logs-.*\.txt$/)
  const stream = await download.createReadStream()
  let content = ''
  for await (const part of stream) content += part.toString()
  expect(content).toContain('Constellation session logs')
  expect(content).toContain('Runtime: browser')
  expect(content).toContain('app.started')
})

test('shows and copies build and browser diagnostics from the top-left menu', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()

  const diagnostics = page.getByRole('dialog', { name: 'Diagnostics' })
  await expect(diagnostics).toContainText('Built (UTC)')
  await expect(diagnostics).toContainText('Built (local)')
  await expect(diagnostics).toContainText('User agent')
  await expect(diagnostics).toContainText('Browser environment')
  await expect(diagnostics).toContainText('does not include locations')
  await diagnostics.getByRole('button', { name: 'Copy diagnostics' }).click()

  const copied = await page.evaluate(
    () => (window as typeof window & { copiedDiagnostics?: string }).copiedDiagnostics,
  )
  expect(copied).toContain('Constellation build')
  expect(copied).toContain('Built (UTC):')
  expect(copied).toContain('Built (local):')
  expect(copied).toContain('Browser environment')
  expect(copied).toContain('User agent:')
  expect(copied).not.toMatch(/share link|peer ID|location coordinates/i)
  await expect(diagnostics.getByRole('status')).toContainText('Copied diagnostics to clipboard')
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

  await expect(page.locator('.dock-peers')).toContainText('Sharing 0 · Seeing 0')
  await openShareCreator(page)

  const approximate = page.getByRole('button', { name: /Neighbourhood/ })
  const veryCoarse = page.getByRole('button', { name: /City/ })
  const oneHour = page.getByRole('button', { name: '1 hour' })
  const oneViewer = page.getByRole('button', { name: '1', exact: true })

  await expect(approximate).toHaveAttribute('aria-pressed', 'true')
  await expect(veryCoarse).toHaveAttribute('aria-pressed', 'false')
  await veryCoarse.click()
  await expect(veryCoarse).toHaveAttribute('aria-pressed', 'true')
  await expect(approximate).toHaveAttribute('aria-pressed', 'false')
  if (test.info().project.name === 'mobile') {
    const action = await page.getByRole('button', { name: 'Create location link' }).boundingBox()
    expect(action).not.toBeNull()
    expect(action!.y + action!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  }
  await expect(oneHour).toHaveAttribute('aria-pressed', 'true')
  await expect(oneViewer).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Until stopped' }).click()
  await expect(page.getByRole('button', { name: 'Create location link' })).toBeDisabled()

  await page.getByRole('checkbox', { name: /I understand this link stays active/ }).check()
  await expect(page.getByRole('button', { name: 'Create location link' })).toBeEnabled()
})

test('QR sharing explains automatic closing and keeps actions clear of the code on phones', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 32.7157, longitude: -117.1611 })
  await page.goto('/')
  await openShareCreator(page)
  await page.getByRole('button', { name: 'Create location link' }).click()
  const qr = page.getByRole('dialog', { name: 'Share this QR code' })
  await expect(qr).toBeVisible({ timeout: 30_000 })
  await expect(qr).toContainText('Waiting for a viewer to connect')
  await expect(qr).toContainText('closes automatically')
  const qrButton = qr.getByRole('button', { name: 'Enlarge QR code' })
  const shareButton = qr.getByRole('button', { name: 'Share via system menu' })
  const image = qr.locator('img.share-ready__qr')
  await expect(image).toBeVisible()
  const code = await qrButton.boundingBox()
  const pixels = await image.boundingBox()
  const share = await shareButton.boundingBox()
  expect(code).not.toBeNull()
  expect(pixels).not.toBeNull()
  expect(share).not.toBeNull()
  expect(Math.abs(code!.width - code!.height)).toBeLessThanOrEqual(2)
  expect(Math.abs(pixels!.width - pixels!.height)).toBeLessThanOrEqual(2)
  expect(Math.abs(code!.width - pixels!.width)).toBeLessThanOrEqual(2)
  expect(code!.y + code!.height).toBeLessThan(share!.y)
  await qrButton.click()
  const enlarged = await qr.getByRole('button', { name: 'Reduce QR code' }).boundingBox()
  expect(enlarged).not.toBeNull()
  expect(Math.abs(enlarged!.width - enlarged!.height)).toBeLessThanOrEqual(2)
  expect(enlarged!.width).toBeGreaterThanOrEqual(code!.width)
  await expect(qr.getByRole('button', { name: 'Close' })).toBeVisible()
  // On a wide desktop dialog the white QR surface must still be square and centered,
  // instead of stretching across the sheet with empty space next to the image.
  await qr.getByRole('button', { name: 'Reduce QR code' }).click()
  await page.setViewportSize({ width: 800, height: 900 })
  const widePanel = await qr.boundingBox()
  const wideCode = await qr.getByRole('button', { name: 'Enlarge QR code' }).boundingBox()
  const wideImage = await image.boundingBox()
  expect(widePanel).not.toBeNull()
  expect(wideCode).not.toBeNull()
  expect(wideImage).not.toBeNull()
  expect(Math.abs(wideCode!.width - wideCode!.height)).toBeLessThanOrEqual(2)
  expect(Math.abs(wideCode!.width - wideImage!.width)).toBeLessThanOrEqual(2)
  expect(wideCode!.width).toBeLessThan(widePanel!.width - 40)
  expect(
    Math.abs(wideCode!.x + wideCode!.width / 2 - widePanel!.x - widePanel!.width / 2),
  ).toBeLessThanOrEqual(2)
})

test('follows live system light and dark preferences', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await openShareCreator(page)

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
  const peerList = await openPeerList(page)
  await peerList.getByRole('button', { name: 'Add peer' }).click()
  const follow = page.getByRole('dialog', { name: 'Follow a location' })
  await expect(follow.getByRole('button', { name: 'Paste link' })).toBeVisible()
  await expect(follow.getByRole('button', { name: 'View location' })).toHaveCount(0)
  await expect(follow.getByRole('textbox')).toHaveCount(0)
})

test('pasting a link opens consent; an empty or invalid clipboard keeps the dialog open', async ({
  page,
}) => {
  await page.goto('/')
  const peers = await openPeerList(page)
  await peers.getByRole('button', { name: 'Add peer' }).click()
  const follow = page.getByRole('dialog', { name: 'Follow a location' })
  const paste = follow.getByRole('button', { name: 'Paste link' })
  await setTestClipboardText(page, '')
  await paste.click()
  await expect(follow.getByRole('alert')).toContainText('empty')

  await setTestClipboardText(page, 'not a location link')
  await paste.click()
  await expect(follow.getByRole('alert')).toContainText('valid location link')

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new DOMException('Denied', 'NotAllowedError')
        },
      },
    })
  })
  await paste.click()
  await expect(follow.getByRole('alert')).toContainText('Clipboard access')

  const invitation = await createShareInvitation({
    baseUrl: 'http://127.0.0.1:4173/',
    sourcePeerId: 'synthetic-source',
    addresses: ['/dns4/relay.example/tcp/443/wss/p2p/synthetic'],
    expiresAt: null,
  })
  await pasteLocationLink(page, invitation.url)
  await expect(follow).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Location link introduction' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Location preview' })).toHaveCount(0)
})

test('Paste link reads the real permitted browser clipboard before presenting consent', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  const invitation = await createShareInvitation({
    baseUrl: 'http://127.0.0.1:4173/',
    sourcePeerId: 'synthetic-source',
    addresses: ['/dns4/relay.example/tcp/443/wss/p2p/synthetic'],
    expiresAt: null,
  })
  await page.evaluate((url) => navigator.clipboard.writeText(url), invitation.url)
  const peers = await openPeerList(page)
  await peers.getByRole('button', { name: 'Add peer' }).click()
  await page
    .getByRole('dialog', { name: 'Follow a location' })
    .getByRole('button', { name: 'Paste link' })
    .click()
  await expect(page.getByRole('dialog', { name: 'Location link introduction' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Location preview' })).toHaveCount(0)
})

test('shares a fresh nickname without an opt-in toggle and explains link privacy', async ({
  page,
}) => {
  await page.goto('/')
  await openShareCreator(page)
  await expect(page.getByRole('checkbox', { name: 'Share a name' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Name to share' })).toHaveValue(
    /^[A-Z][a-z]+ [A-Z][a-z]+$/,
  )
  await page.getByRole('button', { name: 'Explain shared nicknames' }).click()
  const help = page.getByRole('dialog', { name: 'Private nicknames for sharing' })
  await expect(help).toContainText('same link')
  await expect(help).toContainText('Different links')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Explain shared nicknames' })).toBeFocused()
  const name = page.getByRole('textbox', { name: 'Name to share' })
  await name.fill('')
  await expect(page.getByRole('button', { name: 'Create location link' })).toBeDisabled()
  await name.fill('Safe alias')
  await expect(page.getByRole('button', { name: 'Create location link' })).toBeEnabled()
})

test('new share forms get a fresh editable suggestion and dice regeneration', async ({ page }) => {
  await page.goto('/')
  await openShareCreator(page)
  const input = page.getByRole('textbox', { name: 'Name to share' })
  const first = await input.inputValue()
  expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  await page.getByRole('button', { name: 'Generate another name' }).click()
  await expect(input).not.toHaveValue(first)
  await input.fill('Private choice')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await openShareCreator(page)
  await expect(input).not.toHaveValue('Private choice')
  await expect(input).not.toHaveValue(first)
  await expect(input).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
})

test('new share automatically discloses the generated link nickname', async ({ page }) => {
  await page.goto('/')
  await openShareCreator(page)
  const initialName = await page.getByRole('textbox', { name: 'Name to share' }).inputValue()
  expect(initialName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  await page.getByRole('button', { name: 'Create location link' }).click()
  await expect(page.getByRole('dialog', { name: 'Share this QR code' })).toBeVisible({
    timeout: 30_000,
  })
  const shareName = await page.evaluate(async () => {
    const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
    return (await createBrowserPrivateStore().load())?.shares[0]?.name
  })
  expect(shareName).toBe(initialName)
})

test('nests pending share-back under its peer and offers explicit name adoption', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueModuleUrl) throw new Error('Vue module was not loaded.')
    const { createApp, h, reactive } = await import(/* @vite-ignore */ vueModuleUrl)
    const { default: PeerListSheet } = await import('../src/components/PeerListSheet.vue')
    const state = reactive({ name: 'River' })
    const container = document.createElement('div')
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(PeerListSheet, {
          locations: [],
          filter: 'all',
          paused: false,
          viewableIds: [],
          shareBackBusy: false,
          stoppedViewers: [],
          oldShares: [],
          oldFollowing: [],
          peerNamePreferences: [
            {
              peerId: 'synthetic-peer',
              associateNames: false,
              sharedName: null,
              receivedName: 'Forest',
              acceptedName: 'River',
            },
          ],
          shares: [
            {
              shareId: 'synthetic-return',
              recipientPeerId: 'synthetic-peer',
              name: 'My name',
              viewerCount: 0,
              precision: 'approximate',
              expiresAt: null,
            },
            {
              shareId: 'synthetic-unrelated',
              viewerCount: 0,
              precision: 'approximate',
              expiresAt: null,
            },
          ],
          following: [
            {
              shareId: 'synthetic-original',
              peerId: 'synthetic-peer',
              localName: state.name,
              displayName: state.name,
              sourceName: 'Forest',
              color: '#438ec9',
              connected: true,
              status: 'live',
              saved: true,
              expiresAt: null,
              updatesReceived: 1,
              returnPromptSeen: true,
            },
          ],
          onAdoptName: (_peerId: string, name: string) => {
            state.name = name
          },
        }),
    }).mount(container)
  })
  const peer = page
    .locator('.peer-list__item')
    .filter({ has: page.locator('.peer-list__summary-name', { hasText: 'River' }) })
  await expect(page.locator('.peer-list__item')).toHaveCount(2)
  await peer.locator('summary').first().click()
  await expect(peer).toContainText('Waiting for a viewer')
  await expect(peer.locator('.peer-list__summary')).toContainText('Sharing and viewing')
  await peer.getByRole('button', { name: 'Review advertised name Forest' }).click()
  await page
    .getByRole('dialog', { name: 'Adopt advertised name' })
    .getByRole('button', { name: 'Keep current name' })
    .click()
  await expect(peer.locator('.peer-list__summary-name')).toHaveText('River')
  await peer.getByRole('button', { name: 'Review advertised name Forest' }).click()
  await page
    .getByRole('dialog', { name: 'Adopt advertised name' })
    .getByRole('button', { name: 'Adopt name', exact: true })
    .click()
  const renamed = page
    .locator('.peer-list__item')
    .filter({ has: page.locator('.peer-list__summary-name', { hasText: 'Forest' }) })
  await expect(renamed.locator('.peer-list__summary-name')).toHaveText('Forest')
  await expect(renamed.locator('.peer-avatar')).toContainText('F')
})
test('ranks received peers by estimated distance plus their uncertainty radius', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueModuleUrl) throw new Error('Vue module was not loaded.')
    const { createApp, h, reactive } = await import(/* @vite-ignore */ vueModuleUrl)
    const { default: PeerListSheet } = await import('../src/components/PeerListSheet.vue')
    const state = reactive({
      locations: [
        {
          id: 'own',
          isOwn: true,
          latitude: 32.72,
          longitude: -117.16,
          precision: 'exact',
          accuracyMeters: 5,
        },
        {
          id: 'near',
          latitude: 32.7201,
          longitude: -117.16,
          precision: 'approximate',
          radiusMeters: 2000,
        },
        { id: 'far', latitude: 32.723, longitude: -117.16, precision: 'exact', accuracyMeters: 10 },
      ],
    })
    const follows = [
      { shareId: 'near', peerId: 'near-peer', localName: 'Alpha near', displayName: 'Alpha near' },
      {
        shareId: 'far',
        peerId: 'far-peer',
        localName: 'Zulu precise',
        displayName: 'Zulu precise',
      },
    ].map((follow) => ({
      ...follow,
      color: '#438ec9',
      connected: true,
      status: 'live',
      saved: true,
      expiresAt: null,
      updatesReceived: 1,
      returnPromptSeen: true,
    }))
    const container = document.createElement('div')
    container.id = 'proximity-ranking-fixture'
    container.addEventListener('update-radius', () => {
      state.locations[1]!.radiusMeters = 5
    })
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(PeerListSheet, {
          filter: 'viewing',
          paused: false,
          viewableIds: ['near', 'far'],
          shareBackBusy: false,
          stoppedViewers: [],
          oldShares: [],
          oldFollowing: [],
          shares: [],
          following: follows,
          locations: state.locations,
        }),
    }).mount(container)
  })
  const names = page.locator('#proximity-ranking-fixture .peer-list__summary-name')
  await expect(names).toHaveText(['Zulu precise', 'Alpha near'])
  await page.locator('#proximity-ranking-fixture').evaluate((element) => {
    element.dispatchEvent(new Event('update-radius'))
  })
  await expect(names).toHaveText(['Alpha near', 'Zulu precise'])
})

test('hides Share back for authenticated outgoing grants and keeps it for viewing-only peers', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueModuleUrl) throw new Error('Vue module was not loaded.')
    const { createApp, h } = await import(/* @vite-ignore */ vueModuleUrl)
    const { default: PeerListSheet } = await import('../src/components/PeerListSheet.vue')
    const container = document.createElement('div')
    document.body.append(container)
    const following = [
      {
        shareId: 'incoming-a',
        peerId: 'peer-a',
        localName: 'Alice',
        displayName: 'Alice',
        color: '#438ec9',
        connected: true,
        status: 'live',
        saved: true,
        expiresAt: null,
        updatesReceived: 1,
        returnPromptSeen: true,
      },
      {
        shareId: 'incoming-b',
        peerId: 'peer-b',
        localName: 'Bob',
        displayName: 'Bob',
        color: '#438ec9',
        connected: false,
        status: 'delayed',
        saved: true,
        expiresAt: null,
        updatesReceived: 1,
        returnPromptSeen: true,
      },
      {
        shareId: 'incoming-c',
        peerId: 'peer-c',
        localName: 'Cara',
        displayName: 'Cara',
        color: '#438ec9',
        connected: true,
        status: 'live',
        saved: true,
        expiresAt: null,
        updatesReceived: 1,
        returnPromptSeen: true,
      },
    ]
    createApp({
      setup: () => () =>
        h(PeerListSheet, {
          locations: [],
          filter: 'all',
          paused: false,
          viewableIds: following.map(({ shareId }) => shareId),
          shareBackBusy: false,
          stoppedViewers: [],
          oldShares: [],
          oldFollowing: [],
          shares: [
            {
              shareId: 'outgoing-a',
              recipientPeerId: 'peer-a',
              viewerCount: 0,
              precision: 'approximate',
              expiresAt: null,
            },
            {
              shareId: 'outgoing-b',
              recipientPeerId: 'peer-b',
              viewerCount: 1,
              precision: 'approximate',
              expiresAt: null,
              viewers: [
                {
                  peerId: 'peer-b',
                  fingerprint: 'synthetic-viewer-b',
                  lastSeenAt: 1,
                },
              ],
            },
          ],
          following,
        }),
    }).mount(container)
  })
  const peer = (name: string) => page.locator('.peer-list__item').filter({ hasText: name }).first()
  const openDetails = async (name: string) => {
    const item = peer(name)
    await expandPeerDetails(item)
    return item
  }
  await expect(
    (await openDetails('Alice')).getByRole('button', {
      name: 'Share back to Alice',
      exact: true,
    }),
  ).toHaveCount(0)
  await expect(
    (await openDetails('Bob')).getByRole('button', {
      name: 'Share back to Bob',
      exact: true,
    }),
  ).toHaveCount(0)
  await expect(
    (await openDetails('Cara')).getByRole('button', {
      name: 'Share back to Cara',
      exact: true,
    }),
  ).toBeVisible()
})

test('peer list uses distinct main actions, one filter menu, and compact details with header map access', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueModuleUrl) throw new Error('Vue module was not loaded.')
    const { createApp, h, reactive } = await import(/* @vite-ignore */ vueModuleUrl)
    const { default: PeerListSheet } = await import('../src/components/PeerListSheet.vue')
    const state = reactive({
      filter: 'all',
      old: [
        {
          shareId: 'synthetic-ended',
          peerId: 'synthetic-old-peer',
          name: 'Ended fixture',
          endedAt: 1,
          reason: 'expired',
        },
      ],
      focused: false,
      color: '#438ec9',
      compared: '',
      sharedName: null as string | null,
      traceEnabled: false,
      trace: [] as {
        type: 'location'
        receivedAt: number
        capturedAt: number
        latitude: number
        longitude: number
        accuracyMeters: number
        precision: 'approximate'
        sequence: number
      }[],
    })
    ;(window as Window & { __peerCompareTest?: typeof state }).__peerCompareTest = state
    const container = document.createElement('div')
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(PeerListSheet, {
          locations: [],
          filter: state.filter,
          paused: false,
          viewableIds: ['synthetic-incoming'],
          peerNamePreferences: state.sharedName
            ? [
                {
                  peerId: 'synthetic-peer',
                  associateNames: false,
                  sharedName: state.sharedName,
                  receivedName: null,
                },
              ]
            : [],
          shareBackBusy: false,
          stoppedViewers: [],
          oldShares: state.old,
          oldFollowing: [],
          shares: [
            {
              shareId: 'synthetic-outgoing',
              recipientPeerId: 'synthetic-peer',
              name: 'My alias',
              viewerCount: 1,
              precision: 'approximate',
              expiresAt: null,
              viewers: [
                { peerId: 'synthetic-peer', fingerprint: 'synthetic-viewer', lastSeenAt: 1 },
              ],
            },
          ],
          following: [
            {
              shareId: 'synthetic-incoming',
              peerId: 'synthetic-peer',
              localName: 'River',
              displayName: 'River',
              color: state.color,
              connected: true,
              status: 'live',
              saved: true,
              expiresAt: null,
              updatesReceived: 1,
              traceEnabled: state.traceEnabled,
              trace: state.trace,
              returnPromptSeen: true,
            },
          ],
          onFilter: (filter: string) => {
            state.filter = filter
          },
          onClearOld: () => {
            state.old = []
          },
          onFocusPeer: () => {
            state.focused = true
          },
          onCompareDevice: (shareId: string, peerId?: string) => {
            state.compared = `${shareId}:${peerId}`
          },
          onTraceEnabled: (_shareId: string, enabled: boolean) => {
            state.traceEnabled = enabled
            state.trace = enabled
              ? [
                  {
                    type: 'location',
                    receivedAt: Date.now(),
                    capturedAt: Date.now() - 1_000,
                    latitude: 32.7,
                    longitude: -117.1,
                    accuracyMeters: 1_000,
                    precision: 'approximate',
                    sequence: 3,
                  },
                ]
              : []
          },
          onTraceClear: () => {
            state.trace = []
          },
          onColor: (_shareId: string, color: string) => {
            state.color = color
          },
          onProfile: (_peerId: string, _associateNames: boolean, sharedName: string | null) => {
            state.sharedName = sharedName
          },
        }),
    }).mount(container)
  })
  const list = page.locator('.peer-list')
  const share = list.getByRole('button', { name: 'Share location', exact: true })
  const add = list.getByRole('button', { name: 'Add peer', exact: true })
  expect(await share.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    await add.evaluate((el) => getComputedStyle(el).backgroundColor),
  )
  const peer = list.locator('.peer-list__item').first()
  await expect(peer.getByRole('button', { name: 'Show River on map' })).toBeVisible()
  await expect(peer.locator('.peer-list__summary')).toContainText('Sharing and viewing as My alias')
  expect(await peer.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await peer.getByRole('button', { name: 'Show River on map' }).click()
  expect(await peer.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await peer.locator('.peer-list__summary').click()
  await expect(peer.locator('.peer-list__direction-actions')).toHaveCount(0)
  await expect(peer.locator('.peer-list__direction .peer-link-item__colors')).toHaveCount(1)
  await expect(peer.locator('.peer-list__section--connection .peer-link-item__colors')).toHaveCount(
    0,
  )
  const colorPicker = peer.locator('.peer-color-picker')
  await colorPicker.locator('summary').click()
  const wheel = colorPicker.getByRole('slider', { name: 'Hue and saturation' })
  await expect(wheel).toBeVisible()
  await wheel.press('ArrowRight')
  expect(
    await page.evaluate(
      () => (window as Window & { __peerCompareTest?: { color: string } }).__peerCompareTest?.color,
    ),
  ).not.toBe('#438ec9')
  const previousColor = await page.evaluate(
    () => (window as Window & { __peerCompareTest?: { color: string } }).__peerCompareTest?.color,
  )
  const wheelBounds = await wheel.boundingBox()
  if (!wheelBounds) throw new Error('Color wheel is not visible')
  await page.mouse.click(
    wheelBounds.x + wheelBounds.width * 0.75,
    wheelBounds.y + wheelBounds.height * 0.25,
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __peerCompareTest?: { color: string } }).__peerCompareTest?.color,
      ),
    )
    .not.toBe(previousColor)
  await colorPicker.getByRole('textbox', { name: 'Location color hex' }).fill('#e84373')
  await colorPicker.getByRole('textbox', { name: 'Location color hex' }).press('Tab')
  expect(
    await page.evaluate(
      () => (window as Window & { __peerCompareTest?: { color: string } }).__peerCompareTest?.color,
    ),
  ).toBe('#e84373')
  await expect(colorPicker.locator('.peer-color-picker__swatch')).toHaveCSS(
    'background-color',
    'rgb(232, 67, 115)',
  )
  await colorPicker.locator('summary').click()
  await expect(peer.locator('.peer-list__private-names')).toContainText('Unnamed viewer device')
  await expect(peer.locator('.peer-list__private-names')).toContainText(
    'Local label for a device viewing your location',
  )
  await expect(peer.locator('.peer-list__direction')).toHaveCount(2)
  await expect(peer.getByRole('button', { name: 'Revoke link' })).toHaveCount(0)
  await peer.locator('.peer-list__section--link > summary').click()
  await expect(peer.getByRole('button', { name: 'Revoke link' })).toBeVisible()
  const sections = peer.locator('.peer-list__section')
  await expect(sections.locator(':scope > summary')).toHaveCount(4)
  await expect(sections.nth(0)).toContainText('Names and privacy')
  await expect(sections.nth(1)).toContainText('Manage link')
  await expect(sections.nth(2)).toContainText('Connection details')
  await expect(sections.nth(3)).toContainText('Ended history')
  const nameSwitch = peer.getByRole('switch', { name: 'Share my name with River' })
  await expect(nameSwitch).toHaveAttribute('aria-checked', 'false')
  await nameSwitch.click()
  await expect(peer.getByRole('button', { name: 'Save name preferences' })).toBeDisabled()
  await peer.getByRole('textbox', { name: 'Your name for this peer' }).fill('Sender alias')
  await peer.getByRole('button', { name: 'Save name preferences' }).click()
  await expect(nameSwitch).toHaveAttribute('aria-checked', 'true')
  await sections.nth(2).locator(':scope > summary').click()
  await peer.getByRole('button', { name: 'View received messages from River' }).click()
  const traceDialog = page.getByRole('dialog', { name: 'Received messages from River' })
  await expect(traceDialog).toContainText('Recording is off')
  await traceDialog
    .getByRole('checkbox', { name: 'Record received messages and locations' })
    .check()
  await expect(traceDialog).toContainText('Validated update #3')
  await traceDialog.getByRole('button', { name: 'Clear history' }).click()
  await expect(traceDialog).toContainText('No messages in saved history')
  await traceDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(
    peer.getByRole('button', { name: 'View received messages from River' }),
  ).toBeFocused()
  await peer.getByRole('button', { name: 'Verify connection to River' }).click()
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __peerCompareTest?: { compared: string } }).__peerCompareTest
          ?.compared,
    ),
  ).toBe('synthetic-incoming:synthetic-peer')
  await expect(peer).toContainText('Optional device verification')
  await expect(peer.getByRole('button', { name: 'Share back', exact: true })).toHaveCount(0)
  await list.getByRole('button', { name: 'Filter peers', exact: true }).click()
  await list.getByLabel('Show ended').check()
  await expect(list.locator('.peer-list__item')).toHaveCount(2)
  await list.getByRole('button', { name: 'Clear old', exact: true }).click()
  await expect(list.locator('.peer-list__item')).toHaveCount(1)
  await list.getByRole('button', { name: 'Filter peers', exact: true }).click()
  await list.getByRole('button', { name: 'Viewing', exact: true }).click()
  await expect(list).toHaveAttribute('aria-label', 'Following')
  await expect(list.locator('.peer-list__filter-menu')).not.toHaveAttribute('open', '')
  await list.getByRole('button', { name: 'Filter peers', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(list.getByRole('button', { name: 'All', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list.locator('.peer-list__filter-menu')).not.toHaveAttribute('open', '')
  await expect(list.getByRole('button', { name: 'Filter peers', exact: true })).toBeFocused()
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('peer-list-layout.png') })
})

test('selected group scope lists a Local entry and offers local settings', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueModuleUrl) throw new Error('Vue module was not loaded.')
    const { createApp, h } = await import(/* @vite-ignore */ vueModuleUrl)
    const { default: PeerListSheet } = await import('../src/components/PeerListSheet.vue')
    const state = { local: false }
    const container = document.createElement('div')
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(PeerListSheet, {
          locations: [],
          filter: 'group',
          paused: false,
          viewableIds: ['synthetic-followed'],
          limitedIds: ['synthetic-followed'],
          groupScope: true,
          shareBackBusy: false,
          stoppedViewers: [],
          oldShares: [],
          oldFollowing: [],
          shares: [],
          following: [
            {
              shareId: 'synthetic-followed',
              peerId: 'synthetic-peer',
              localName: 'River',
              displayName: 'River',
              color: '#438ec9',
              connected: true,
              status: 'live',
              saved: true,
              expiresAt: null,
              updatesReceived: 1,
              returnPromptSeen: true,
            },
          ],
          onOpenLocalSettings: () => {
            state.local = true
          },
        }),
    }).mount(container)
    ;(window as typeof window & { groupScopeTest?: { local: boolean } }).groupScopeTest = state
  })
  const list = page.locator('.peer-list')
  await expect(list).toHaveAttribute('aria-label', 'Selected group')
  await expect(list.locator('.peer-list__local')).toContainText('Local')
  await expect(list.locator('.peer-list__local')).toContainText('This device')
  await list.getByRole('button', { name: 'Filter peers', exact: true }).click()
  await expect(list.getByRole('button', { name: 'Selected group', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await list.getByRole('button', { name: 'Local', exact: true }).click()
  expect(
    await page.evaluate(
      () => (window as typeof window & { groupScopeTest: { local: boolean } }).groupScopeTest.local,
    ),
  ).toBe(true)
})

test('filter menu floats above an empty peer list instead of being clipped', async ({ page }) => {
  await page.goto('/')
  const list = await openPeerList(page)
  await expect(list.getByText('No peers in this list yet.')).toBeVisible()
  await list.getByRole('button', { name: 'Filter peers', exact: true }).click()
  const options = list.locator('.peer-list__filter-options')
  await expect(options).toBeVisible()
  const filterButton = list.getByRole('button', { name: 'Filter peers', exact: true })
  await expect
    .poll(async () => {
      const optionsBox = await options.boundingBox()
      const buttonBox = await filterButton.boundingBox()
      if (!optionsBox || !buttonBox) return false
      const anchoredBelow = Math.abs(optionsBox.y - (buttonBox.y + buttonBox.height + 8)) <= 2
      const anchoredAbove = Math.abs(optionsBox.y + optionsBox.height - (buttonBox.y - 8)) <= 2
      return anchoredBelow || anchoredAbove
    })
    .toBe(true)
  const dialogBox = await list.boundingBox()
  const optionsBox = await options.boundingBox()
  const clearOld = options.getByRole('button', { name: 'Clear old', exact: true })
  const clearOldBox = await clearOld.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(optionsBox).not.toBeNull()
  expect(clearOldBox).not.toBeNull()
  expect(
    optionsBox!.y < dialogBox!.y ||
      optionsBox!.y + optionsBox!.height > dialogBox!.y + dialogBox!.height,
  ).toBe(true)
  const point = {
    x: clearOldBox!.x + clearOldBox!.width / 2,
    y: clearOldBox!.y + clearOldBox!.height / 2,
  }
  expect(point.y).toBeGreaterThan(0)
  expect(point.y).toBeLessThan(page.viewportSize()!.height)
  const insideMenu = await page.evaluate(({ x, y }): boolean => {
    const hit = document.elementFromPoint(x, y)
    return hit !== null && hit.closest('.peer-list__filter-options') !== null
  }, point)
  expect(insideMenu).toBe(true)
  await page.screenshot({ path: test.info().outputPath('peer-list-filter-menu.png') })
})

test('Android sharing preferences stay editable with missing permissions and show the runtime fallback', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueUrl) throw new Error('Vue was not loaded.')
    const { createApp, h, reactive } = await import(/* @vite-ignore */ vueUrl)
    const { default: SettingsSheet } = await import('../src/components/SettingsSheet.vue')
    const state = reactive({
      backgroundFollowing: true,
      backgroundReceiverActive: false,
      savedFollowCount: 0,
      permissions: {
        location: false,
        background: false,
        notifications: false,
        servicesEnabled: true,
      },
      devicePolicies: {
        batteryOptimizationExempt: false,
        powerSaverEnabled: true,
        backgroundRestricted: false,
        dataSaverEnabled: true,
      },
      busy: false,
      error: '',
    })
    const container = document.createElement('div')
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(SettingsSheet, {
          behavior: { publication: 'background', battery: 'balanced', network: 'always' },
          isAndroid: true,
          review: true,
          hasShares: false,
          ...state,
          onSetBackgroundFollowing: (enabled: boolean) => {
            state.backgroundFollowing = enabled
          },
          onOpenSystemSettings: (target: string) => {
            container.dataset.systemSettings = target
          },
          onEnablePermissions: () => {
            state.permissions = {
              location: true,
              background: true,
              notifications: true,
              servicesEnabled: true,
            }
          },
          onSave: (behavior: {
            publication: string
            battery: string
            network: string
            backgroundIntervalMinutes?: number
          }) => {
            container.dataset.publication = behavior.publication
            container.dataset.battery = behavior.battery
            container.dataset.network = behavior.network
            container.dataset.interval = String(behavior.backgroundIntervalMinutes ?? 5)
            state.error = 'Synthetic save failure; retry is available.'
          },
        }),
    }).mount(container)
  })
  const setup = page.getByRole('dialog', { name: 'Set up sharing' })
  const backgroundFollowing = setup.getByRole('checkbox', {
    name: "Keep receiving saved peers' locations in the background",
  })
  await expect(backgroundFollowing).toBeChecked()
  await expect(backgroundFollowing).toBeEnabled()
  await backgroundFollowing.uncheck()
  await expect(backgroundFollowing).not.toBeChecked()
  await backgroundFollowing.check()
  await expect(backgroundFollowing).toBeChecked()
  await expect(setup).toContainText('Effective fallback')
  await expect(setup).toContainText('Battery saver')
  await expect(setup).toContainText('Data Saver')
  await expect(setup).toContainText('Optimized — may delay updates')
  await setup.getByRole('button', { name: 'Change Battery saver' }).click()
  await expect(page.locator('[data-system-settings="power-saver"]')).toHaveCount(1)
  await expect(setup.getByRole('button', { name: /In background/ })).toBeEnabled()
  await expect(setup.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  const backgroundInterval = setup.getByRole('combobox', {
    name: 'Background location interval',
  })
  await expect(backgroundInterval).toHaveValue('5')
  await backgroundInterval.selectOption('10')
  await expect(setup).toContainText(
    'Effective fallback: location sharing only while the app is open',
  )
  await setup.getByRole('button', { name: 'Battery saver', exact: false }).first().click()
  await setup.getByRole('checkbox', { name: /Pause updates on metered networks/ }).check()
  await setup.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.locator('[data-publication="background"]')).toHaveCount(1)
  await expect(page.locator('[data-battery="saver"]')).toHaveCount(1)
  await expect(page.locator('[data-network="pause-when-metered"]')).toHaveCount(1)
  await expect(page.locator('[data-interval="10"]')).toHaveCount(1)
  await expect(setup.getByRole('alert')).toContainText('Synthetic save failure')
  await setup.getByRole('button', { name: 'Enable background sharing' }).click()
  await expect(setup).not.toContainText(
    'Effective fallback: location sharing only while the app is open',
  )
  await expect(setup.getByRole('button', { name: /In background/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(setup.getByRole('button', { name: 'Save settings' })).toBeEnabled()
  await setup.getByRole('button', { name: 'Save settings' }).focus()
  await page.keyboard.press('Tab')
  await expect(setup.getByRole('button', { name: 'Close settings' })).toBeFocused()
})
test('Android background-following preference survives reload and peer/receiver state changes', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(() =>
    window.localStorage.removeItem('constellation.background-following-enabled'),
  )
  const mount = async () =>
    page.evaluate(async () => {
      const vueUrl = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
      if (!vueUrl) throw new Error('Vue was not loaded.')
      const { createApp, h, reactive } = await import(/* @vite-ignore */ vueUrl)
      const { default: SettingsSheet } = await import('../src/components/SettingsSheet.vue')
      const { readBackgroundFollowingPreference, persistBackgroundFollowingPreference } =
        await import('../src/android/backgroundFollowingPreference.ts')
      const state = reactive({
        preference: readBackgroundFollowingPreference(window.localStorage),
        receiverActive: false,
        savedFollowCount: 0,
      })
      const host = document.createElement('div')
      host.dataset.testid = 'background-following-host'
      document.body.append(host)
      const simulate = document.createElement('button')
      simulate.textContent = 'Simulate peer reload and receiver handoff'
      simulate.dataset.testid = 'simulate-receiver'
      simulate.addEventListener('click', () => {
        state.receiverActive = !state.receiverActive
        state.savedFollowCount = state.receiverActive ? 2 : 0
      })
      document.body.append(simulate)
      createApp({
        setup: () => () =>
          h(SettingsSheet, {
            behavior: { publication: 'foreground', battery: 'balanced', network: 'always' },
            isAndroid: true,
            review: false,
            hasShares: false,
            busy: false,
            backgroundFollowing: state.preference,
            backgroundReceiverActive: state.receiverActive,
            savedFollowCount: state.savedFollowCount,
            onSetBackgroundFollowing: (enabled: boolean) => {
              state.preference = enabled
              if (!persistBackgroundFollowingPreference(window.localStorage, enabled)) {
                throw new Error('Test WebView storage write failed.')
              }
            },
          }),
      }).mount(host)
    })
  await mount()
  const checkbox = () =>
    page.getByRole('dialog', { name: 'Settings' }).getByRole('checkbox', {
      name: "Keep receiving saved peers' locations in the background",
    })
  // Check the default first, with neither saved peers nor an active receiver.
  await expect(checkbox()).toBeChecked()
  await page.getByTestId('simulate-receiver').evaluate((button: HTMLElement) => button.click())
  await expect(
    page.getByRole('status').filter({ hasText: 'Android receiver: running' }),
  ).toBeVisible()
  await expect(checkbox()).toBeChecked()
  await checkbox().uncheck()
  await expect(
    page.getByRole('alert').filter({ hasText: 'receiver is still running' }),
  ).toBeVisible()
  await page.reload()
  await mount()
  await expect(checkbox()).not.toBeChecked()
  await checkbox().check()
  await expect(checkbox()).toBeChecked()
  await page.reload()
  await mount()
  await expect(checkbox()).toBeChecked()
  await expect(
    page.getByRole('status').filter({ hasText: 'Android receiver: not running' }),
  ).toBeVisible()
})

test('Android browser opens shared locations directly after explicit consent without GPS prompts', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const androidViewerContext = await browser.newContext({
    baseURL,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
  })
  const desktopViewerContext = await browser.newContext({ baseURL })
  await androidViewerContext.addInitScript(() => {
    const state = window as typeof window & { ownGpsRequests: number }
    state.ownGpsRequests = 0
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: () => {
          state.ownGpsRequests += 1
          return 1
        },
        getCurrentPosition: () => {
          state.ownGpsRequests += 1
        },
        clearWatch: () => undefined,
      },
    })
  })
  try {
    const source = await sourceContext.newPage()
    const androidViewer = await androidViewerContext.newPage()
    const desktopViewer = await desktopViewerContext.newPage()
    await source.goto('/')
    await openShareCreator(source)
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await androidViewer.goto(url)
    const intro = androidViewer.getByRole('dialog', { name: 'Location link introduction' })
    await expect(intro).toBeVisible()
    await expect(intro).toContainText('Your location will not be shared')
    await expect(intro.getByRole('button')).toHaveCount(2)
    await expect(androidViewer.getByRole('region', { name: 'Location preview' })).toHaveCount(0)
    await intro.getByRole('button', { name: 'Cancel' }).click()
    await expect(intro).toHaveCount(0)

    await androidViewer.goto(url)
    await expect(intro).toBeVisible()
    await intro.getByRole('button', { name: 'See location' }).click()
    const preview = androidViewer.getByRole('region', { name: 'Location preview' })
    await expect(preview.getByRole('button', { name: 'Add peer' })).toBeVisible({
      timeout: 30_000,
    })
    expect(
      await androidViewer.evaluate(
        () => (window as typeof window & { ownGpsRequests: number }).ownGpsRequests,
      ),
    ).toBe(0)

    await androidViewer.goto(url)
    await expect(intro).toBeVisible()
    await desktopViewer.goto(url)
    const desktopIntro = desktopViewer.getByRole('dialog', { name: 'Location link introduction' })
    await expect(desktopIntro).toBeVisible()
    await desktopIntro.getByRole('button', { name: 'See location' }).click()
    await expect(desktopViewer.getByRole('region', { name: 'Location preview' })).toBeVisible({
      timeout: 30_000,
    })
  } finally {
    await desktopViewerContext.close()
    await androidViewerContext.close()
    await sourceContext.close()
  }
})

test('device verification dialog requires a local decision and treats mismatches as unsafe', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueModuleUrl) throw new Error('Vue module was not loaded.')
    const { createApp, h, reactive } = await import(/* @vite-ignore */ vueModuleUrl)
    const { default: DeviceComparisonSheet } = await import(
      '../src/components/DeviceComparisonSheet.vue'
    )
    const comparison = {
      shareId: 'synthetic-share-0001',
      ownPeerId: 'viewer-A',
      peerId: 'source-B',
      role: 'viewer' as const,
      challenge: 'A'.repeat(43),
      letters: 'RKMP',
      expiresAt: Date.now() + 120_000,
    }
    const state = reactive({
      viewer: true,
      mismatch: false,
      canBlock: false,
      comparison: comparison as typeof comparison | undefined,
      events: [] as string[],
    })
    ;(window as Window & { __deviceDialogTest?: typeof state }).__deviceDialogTest = state
    const container = document.createElement('div')
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(DeviceComparisonSheet, {
          label: 'River',
          viewer: state.viewer,
          comparison: state.comparison,
          mismatch: state.mismatch,
          pending: false,
          canReject: !state.viewer && !state.canBlock,
          canBlock: state.canBlock,
          onConfirm: () => state.events.push('confirm'),
          onMismatch: () => {
            state.events.push('mismatch')
            state.mismatch = true
          },
          onStop: () => state.events.push('stop'),
          onBlock: () => state.events.push('block'),
          onClear: () => state.events.push('clear'),
          onClose: () => state.events.push('close'),
        }),
    }).mount(container)
  })

  const dialog = page.getByRole('dialog', { name: 'Verify connection' })
  await expect(dialog).toContainText('RKMP')
  await expect(dialog).toContainText('not the person')
  await expect(dialog).toContainText('does not approve location access')
  const events = () =>
    page.evaluate(
      () =>
        (window as Window & { __deviceDialogTest?: { events: string[] } }).__deviceDialogTest!
          .events,
    )
  expect(await events()).toEqual([])
  await dialog.getByRole('button', { name: 'Letters match' }).click()
  expect(await events()).toEqual(['confirm'])
  await dialog.getByRole('button', { name: "Letters don't match" }).click()
  await expect(dialog.getByRole('alert')).toContainText('Do not trust this connection')
  await dialog.getByRole('button', { name: 'Stop following' }).click()
  expect(await events()).toEqual(['confirm', 'mismatch', 'stop'])

  await page.evaluate(() => {
    const state = (
      window as Window & {
        __deviceDialogTest?: {
          viewer: boolean
          mismatch: boolean
          comparison?: unknown
        }
      }
    ).__deviceDialogTest!
    state.viewer = false
    state.mismatch = false
    state.comparison = undefined
  })
  await expect(dialog).toContainText('Waiting for the viewer to start verification')
  await expect(dialog.getByRole('button', { name: 'Start verification' })).toHaveCount(0)

  await page.evaluate(() => {
    const state = (
      window as Window & {
        __deviceDialogTest?: {
          viewer: boolean
          mismatch: boolean
          canBlock: boolean
        }
      }
    ).__deviceDialogTest!
    state.mismatch = true
    state.canBlock = true
  })
  await dialog.getByRole('button', { name: 'Block this device' }).click()
  expect(await events()).toEqual(['confirm', 'mismatch', 'stop', 'block'])
  await page.evaluate(() => {
    const state = (
      window as Window & {
        __deviceDialogTest?: {
          viewer: boolean
          mismatch: boolean
          comparison?: object
        }
      }
    ).__deviceDialogTest!
    state.viewer = true
    state.mismatch = false
    state.comparison = {
      shareId: 'synthetic-share-0001',
      ownPeerId: 'viewer-A',
      peerId: 'source-B',
      role: 'viewer',
      challenge: 'A'.repeat(43),
      letters: 'RKMP',
      expiresAt: Date.now() - 5_000,
      confirmedAt: Date.now() - 30_000,
    }
  })
  await expect(dialog).toContainText("other device's confirmation is not known")
  await dialog.getByRole('button', { name: 'Clear local verification' }).click()
  expect(await events()).toEqual(['confirm', 'mismatch', 'stop', 'block', 'clear'])
})
