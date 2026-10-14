import { expect, test } from '@playwright/test'

import { createShareInvitation } from '../src/sharing/shareLink.ts'
import { openPeerList, openShareCreator } from './fixtures/peer-navigation.ts'

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
  await form.getByLabel('Share a name').fill('Synthetic River')
  await form.getByRole('button', { name: 'Very coarse 20 km radius', exact: true }).click()
  await form.getByRole('button', { name: '8 hours', exact: true }).click()
  await form.getByRole('button', { name: 'No share cap', exact: true }).click()
  await expect(
    form.getByRole('button', { name: 'No share cap', exact: true }).locator('svg'),
  ).toHaveCount(1)
  await form.getByRole('button', { name: 'More info', exact: true }).click()
  const privacy = page.getByRole('dialog', { name: 'Your location stays between devices' })
  await expect(privacy).toContainText('no location history on its servers')
  await expect(privacy).toContainText('approximate area')
  await expect(privacy).toContainText('receiver can still save')
  await expect(form).not.toBeVisible()
  await page.keyboard.press('Escape')
  await expect(form.getByRole('button', { name: 'More info', exact: true })).toBeFocused()
  await expect(form.getByLabel('Share a name')).toHaveValue('Synthetic River')
  await expect(form.getByRole('button', { name: '8 hours', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(form.getByRole('button', { name: 'No share cap', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(form).toContainText('End-to-end encrypted. No central location storage.')
})

test('device behavior lives in Settings and browser background sharing is visibly unavailable', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings.getByRole('button', { name: /In background/ })).toBeDisabled()
  await expect(settings).toContainText('native Android app')
  await expect(settings.getByRole('button', { name: /While app is open/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open menu', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(settings.getByRole('button', { name: /While app is open/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
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
  await expect(page.getByRole('textbox', { name: 'Paste location link' })).toBeVisible()
})

test('lets the sender optionally include a name without device behavior controls', async ({
  page,
}) => {
  await page.goto('/')
  await openShareCreator(page)

  await page.getByRole('textbox', { name: 'Share a name' }).fill('River')
  await expect(page.getByRole('button', { name: /While app is open|In background/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create location link' })).toBeEnabled()
})

test('new share forms get a fresh editable suggestion and dice regeneration', async ({ page }) => {
  await page.goto('/')
  await openShareCreator(page)
  const input = page.getByLabel('Share a name', { exact: true })
  const first = await input.inputValue()
  expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  await page.getByRole('button', { name: 'Generate another name' }).click()
  await expect(input).not.toHaveValue(first)
  await input.fill('Private choice')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await openShareCreator(page)
  await expect(input).not.toHaveValue('Private choice')
  await expect(input).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
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
          filter: 'all',
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
    })
    const container = document.createElement('div')
    document.body.append(container)
    createApp({
      setup: () => () =>
        h(PeerListSheet, {
          filter: state.filter,
          viewableIds: ['synthetic-incoming'],
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
              color: '#438ec9',
              connected: true,
              status: 'live',
              saved: true,
              expiresAt: null,
              updatesReceived: 1,
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
  expect(await peer.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await peer.getByRole('button', { name: 'Show River on map' }).click()
  expect(await peer.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await peer.locator('.peer-list__summary').click()
  await expect(peer.locator('.peer-list__relationship')).toHaveCount(2)
  await expect(peer.getByRole('button', { name: 'Revoke link' })).toHaveCount(0)
  await peer.getByRole('button', { name: 'Manage link' }).click()
  await expect(peer.getByRole('button', { name: 'Revoke link' })).toBeVisible()
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

test('Android setup requires permissions or an explicit foreground choice', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const vueUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueUrl) throw new Error('Vue was not loaded.')
    const { createApp, h, reactive } = await import(/* @vite-ignore */ vueUrl)
    const { default: SettingsSheet } = await import('../src/components/SettingsSheet.vue')
    const state = reactive({
      permissions: {
        location: false,
        background: false,
        notifications: false,
        servicesEnabled: true,
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
          onEnablePermissions: () => {
            state.permissions = {
              location: true,
              background: true,
              notifications: true,
              servicesEnabled: true,
            }
          },
          onSave: (behavior: { publication: string }) => {
            container.dataset.publication = behavior.publication
            state.error = 'Synthetic save failure; retry is available.'
          },
        }),
    }).mount(container)
  })
  const setup = page.getByRole('dialog', { name: 'Set up sharing' })
  await expect(setup).toContainText('Background sharing is the Android default')
  await expect(setup.getByRole('button', { name: /In background/ })).toBeDisabled()
  await expect(setup.getByRole('button', { name: 'Save settings' })).toBeDisabled()
  await setup.getByRole('button', { name: 'Use while app is open' }).click()
  await expect(page.locator('[data-publication="foreground"]')).toHaveCount(1)
  await expect(setup.getByRole('alert')).toContainText('Synthetic save failure')
  await setup.getByRole('button', { name: 'Enable background sharing' }).click()
  await expect(setup.getByRole('button', { name: /In background/ })).toBeEnabled()
  await setup.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.locator('[data-publication="background"]')).toHaveCount(1)
  await setup.getByRole('button', { name: 'Save settings' }).focus()
  await page.keyboard.press('Tab')
  await expect(setup.getByRole('button', { name: 'Close settings' })).toBeFocused()
})
