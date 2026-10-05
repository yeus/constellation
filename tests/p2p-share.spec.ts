import { expect, test } from '@playwright/test'
import QRCode from 'qrcode'

import { parseShareInvitation } from '../src/sharing/shareLink.ts'
import { withTwoSources } from './fixtures/two-sources.ts'

test('revocation during viewer admission preserves ended history', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { probeRevocationDuringAdmission } = await import('../tests/fixtures/share-probe.ts')
    return probeRevocationDuringAdmission()
  })
  expect(result).toEqual({ following: ['revoked'], history: ['revoked'] })
})

test('private peers do not announce themselves through public discovery', async ({ page }) => {
  await page.goto('/')
  const announcements = await page.evaluate(async () => {
    const { probePrivateDiscovery } = await import('../tests/fixtures/share-probe.ts')
    return probePrivateDiscovery()
  })
  expect(announcements).toBe(0)
})

test('a source can accept one return share and automatically accept other viewers of that link', async ({
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
  const viewerContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: ['geolocation'],
  })
  const secondViewerContext = await browser.newContext({ baseURL })
  const thirdViewerContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    const viewer = await viewerContext.newPage()
    const secondViewer = await secondViewerContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await expect(source.getByRole('img', { name: 'Location share QR code' })).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    )
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(source.getByRole('button', { name: /Sharing 1 · next ends/ })).toBeVisible()

    await viewer.goto(url)
    await viewer.getByRole('button', { name: 'Keep following' }).click({ timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Save location' }).click()
    await viewer.getByRole('button', { name: 'Share approximate location for 1 hour' }).click()

    const offer = source.getByRole('region', { name: 'Return location offered' })
    await expect(offer).toBeVisible({ timeout: 30_000 })
    await expect(offer).toContainText('A viewer wants to share their location back')
    await source.getByRole('button', { name: 'Open menu' }).click()
    await source.getByRole('button', { name: 'P2P diagnostics' }).click()
    const connections = await source
      .getByRole('dialog', { name: 'P2P diagnostics' })
      .locator('li')
      .allTextContents()
    expect(connections.some((connection) => connection.trim().startsWith('viewer ·'))).toBe(true)
    await source
      .getByRole('dialog', { name: 'P2P diagnostics' })
      .getByRole('button', { name: 'Close' })
      .click()
    await secondViewer.goto(url)
    await expect(secondViewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await secondViewer.getByRole('button', { name: 'Open menu' }).click()
    await secondViewer.getByRole('button', { name: 'Following (1)' }).click()
    await secondViewer
      .getByRole('button', { name: /Share approximate location for 1 hour back to/ })
      .click()
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.returnOffers?.length
        }),
      )
      .toBe(2)
    await offer
      .getByRole('button', { name: 'Accept this and future shares from this link' })
      .click()
    await expect(source.getByText('Seeing 2')).toBeVisible({ timeout: 30_000 })
    await expect(source.locator('.toast')).toContainText('Future shares from this link')
    await source.getByRole('button', { name: 'Open menu' }).click()
    await source.getByRole('button', { name: 'Following (2)' }).click()
    const sourceFollowing = source.getByRole('dialog', { name: 'Following' })
    await expect(
      sourceFollowing.getByRole('button', {
        name: /Share approximate location for 1 hour back to/,
      }),
    ).toHaveCount(0)
    await sourceFollowing.getByRole('button', { name: 'Close' }).click()

    const thirdViewer = await thirdViewerContext.newPage()
    await thirdViewer.goto(url)
    await expect(thirdViewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await thirdViewer.getByRole('button', { name: 'Open menu' }).click()
    await thirdViewer.getByRole('button', { name: 'Following (1)' }).click()
    await thirdViewer
      .getByRole('button', { name: /Share approximate location for 1 hour back to/ })
      .click()
    await expect(source.getByText('Seeing 3')).toBeVisible({ timeout: 30_000 })
    await expect(source.getByRole('region', { name: 'Return location offered' })).toHaveCount(0)
  } finally {
    await thirdViewerContext.close()
    await secondViewerContext.close()
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('scans a QR share through the normal browser preview flow', async ({
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
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    const viewer = await viewerContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    const modules = Array.from(QRCode.create(url).modules.data)
    await viewerContext.addInitScript((qrModules) => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => new MediaStream() },
      })
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        configurable: true,
        get: () => HTMLMediaElement.HAVE_CURRENT_DATA,
      })
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
        configurable: true,
        get: () => 640,
      })
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
        configurable: true,
        get: () => 480,
      })
      const matrixSize = Math.sqrt(qrModules.length)
      const nativeGetContext = Object.getOwnPropertyDescriptor(
        HTMLCanvasElement.prototype,
        'getContext',
      )?.value as (this: HTMLCanvasElement, ...args: unknown[]) => RenderingContext | null
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
          if (contextId !== '2d' || this.width !== 640 || this.height !== 480) {
            return Reflect.apply(nativeGetContext, this, [contextId, ...args])
          }
          return {
            drawImage: () => undefined,
            getImageData: (_x: number, _y: number, width: number, height: number) => {
              const pixels = new Uint8ClampedArray(width * height * 4)
              for (let index = 0; index < pixels.length; index += 4) {
                pixels[index] = pixels[index + 1] = pixels[index + 2] = pixels[index + 3] = 255
              }
              const scale = Math.max(
                1,
                Math.floor((Math.min(width, height) - 8) / (matrixSize + 8)),
              )
              const left = Math.floor((width - matrixSize * scale) / 2)
              const top = Math.floor((height - matrixSize * scale) / 2)
              qrModules.forEach((dark, moduleIndex) => {
                if (dark !== 1) return
                const moduleX = moduleIndex % matrixSize
                const moduleY = Math.floor(moduleIndex / matrixSize)
                for (let y = top + moduleY * scale; y < top + (moduleY + 1) * scale; y += 1) {
                  for (let x = left + moduleX * scale; x < left + (moduleX + 1) * scale; x += 1) {
                    const pixelIndex = (y * width + x) * 4
                    pixels[pixelIndex] = pixels[pixelIndex + 1] = pixels[pixelIndex + 2] = 0
                  }
                }
              })
              return { data: pixels, width, height, colorSpace: 'srgb' }
            },
          } as unknown as CanvasRenderingContext2D
        },
      })
    }, modules)

    await viewer.goto('/')
    await viewer.getByRole('button', { name: 'Open menu' }).click()
    await viewer.getByRole('button', { name: 'Follow a link' }).click()
    await viewer.getByRole('button', { name: 'Scan QR code' }).click()
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    expect(await viewer.evaluate(() => location.hash)).toBe('')
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('very coarse shares deliver a 20 km approximate area to a browser viewer', async ({
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
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    const viewer = await viewerContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: /Very coarse/ }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    const broadState = () =>
      source.evaluate(async () => {
        const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
        const share = (await createBrowserPrivateStore().load())?.shares[0]
        return { precision: share?.precision, radiusMeters: share?.approximation?.radiusMeters }
      })
    await expect.poll(broadState).toEqual({ precision: 'very-coarse', radiusMeters: 20_000 })

    await source.reload()
    await expect(source.getByRole('button', { name: 'Sharing 1' })).toBeVisible()
    await expect.poll(broadState).toEqual({ precision: 'very-coarse', radiusMeters: 20_000 })

    await viewer.goto(url)
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await viewer.getByRole('button', { name: 'Open menu' }).click()
    await viewer.getByRole('button', { name: 'Following (1)' }).click()
    await expect(viewer.getByRole('button', { name: 'Show on map' })).toBeVisible({
      timeout: 30_000,
    })
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('browser link previews immediately and saves only after Keep following', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const viewerContext = await browser.newContext({ baseURL })
  await viewerContext.addInitScript(() => {
    const state = window as typeof window & { ownGpsRequests: number }
    state.ownGpsRequests = 0
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        watchPosition: () => {
          state.ownGpsRequests += 1
          return 1
        },
        clearWatch: () => undefined,
      },
    })
  })
  const requestedUrls: string[] = []
  viewerContext.on('request', (request) => requestedUrls.push(request.url()))
  try {
    const source = await sourceContext.newPage()
    const viewer = await viewerContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })

    await viewer.goto(url)
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    expect(requestedUrls.every((requestedUrl) => !requestedUrl.includes('#share='))).toBe(true)
    expect(await viewer.evaluate(() => location.hash)).toBe('')
    expect(
      await viewer.evaluate(
        () => (window as typeof window & { ownGpsRequests: number }).ownGpsRequests,
      ),
    ).toBe(0)
    const followsBefore = await viewer.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      return (await createBrowserPrivateStore().load())?.followed.length
    })
    expect(followsBefore).toBe(0)
    await viewer.getByRole('button', { name: 'Keep following' }).click()
    await expect(viewer.getByRole('dialog', { name: 'Keep following' })).toBeVisible()
    await viewer.getByRole('textbox', { name: 'Nickname' }).fill('My friend')
    await viewer.getByRole('button', { name: 'Save location' }).click()
    await expect(viewer.getByRole('region', { name: 'Share back invitation' })).toContainText(
      'Share yours back',
    )
    await viewer.getByRole('button', { name: 'Share approximate location for 1 hour' }).click()
    await expect(viewer.getByRole('heading', { name: 'Share this QR code' })).toBeVisible()
    await viewer.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(viewer.getByText('Seeing 1')).toBeVisible()
    await expect
      .poll(() =>
        viewer.evaluate(
          () => (window as typeof window & { ownGpsRequests: number }).ownGpsRequests,
        ),
      )
      .toBe(1)
    await viewer.reload()
    await expect(viewer.getByText('Seeing 1')).toBeVisible({ timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Seeing 1' }).click()
    const follows = viewer.getByRole('dialog', { name: 'Following' })
    await expect(follows).toContainText('My friend')
    await expect(follows.getByRole('button', { name: /Share approximate location/ })).toHaveCount(0)
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText('Saved')
    await expect(
      viewer
        .getByRole('dialog', { name: 'Following' })
        .getByRole('button', { name: 'Show on map' }),
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('uses a distinct persistent source identity for each share link', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  try {
    const source = await sourceContext.newPage()
    await source.goto('/')

    const createLink = async (): Promise<string> => {
      await source.getByRole('button', { name: 'Share location' }).click()
      await source.getByRole('button', { name: 'Create private link' }).click()
      const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
      await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      return url
    }

    const firstUrl = await createLink()
    await source.getByRole('button', { name: 'Show sharing actions' }).click()
    const secondUrl = await createLink()
    const first = parseShareInvitation(firstUrl)
    const second = parseShareInvitation(secondUrl)

    expect(first.sourcePeerId).not.toBe(second.sourcePeerId)
    expect(first.addresses).not.toEqual(second.addresses)
    expect(first.addresses.every((address) => address.includes(first.sourcePeerId))).toBe(true)
    expect(second.addresses.every((address) => address.includes(second.sourcePeerId))).toBe(true)

    await source.reload()
    await expect(source.getByRole('button', { name: 'Sharing 2' })).toBeVisible({ timeout: 30_000 })
    const restoredUrls = await source.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      return (await createBrowserPrivateStore().load())?.shares.map(({ url }) => url) ?? []
    })
    expect(new Set(restoredUrls)).toEqual(new Set([firstUrl, secondUrl]))
  } finally {
    await sourceContext.close()
  }
})

test('enforces the configured one-viewer share capacity', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('A base URL is required.')
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const firstContext = await browser.newContext({ baseURL })
  const secondContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    const first = await firstContext.newPage()
    const second = await secondContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })

    await first.goto(url)
    await expect(first.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await second.goto(url)
    await expect(second.getByText('Share access denied.')).toBeVisible({ timeout: 30_000 })
  } finally {
    await secondContext.close()
    await firstContext.close()
    await sourceContext.close()
  }
})

test('shares a browser location over an authenticated P2P stream', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('The test requires a configured base URL.')

  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const viewerContext = await browser.newContext({ baseURL })
  const secondViewerContext = await browser.newContext({ baseURL })
  const source = await sourceContext.newPage()
  const viewer = await viewerContext.newPage()
  const secondViewer = await secondViewerContext.newPage()

  try {
    await source.goto('/')
    await expect(source.getByRole('button', { name: 'Center on my location' })).toBeVisible()
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const shareUrl = await source.getByLabel('Share link').inputValue({
      timeout: 30_000,
    })
    const capability = parseShareInvitation(shareUrl)
    expect(capability.addresses.length).toBeGreaterThan(0)
    expect(capability.addresses.length).toBeLessThanOrEqual(4)
    expect(
      capability.addresses.every((address) => address.startsWith('/ip4/127.0.0.1/tcp/9111/ws/')),
    ).toBe(true)
    await sourceContext.setGeolocation({ latitude: 48.13725, longitude: 11.57565 })
    await expect
      .poll(async () =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          const saved = await createBrowserPrivateStore().load()
          return saved?.shares[0]?.approximation?.radiusMeters ?? 0
        }),
      )
      .toBeGreaterThan(0)
    await source.reload()
    await expect(source.getByText('Sharing 1')).toBeVisible()
    await sourceContext.setGeolocation({ latitude: 48.1373, longitude: 11.5757 })
    await expect(source.getByText('Sharing 1')).toBeVisible({
      timeout: 15_000,
    })

    const webRtc = await source.evaluate(async (url) => {
      const { probeWebRtcReachability } = await import('../tests/fixtures/share-probe.ts')
      return probeWebRtcReachability(url, 7_000)
    }, shareUrl)
    expect(webRtc.direct).toBe(true)
    expect(webRtc.transport).toMatch(/WebRTC/)
    expect(webRtc.expectedPeer).toBe(true)

    await viewer.goto(shareUrl)
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await viewer
      .getByRole('region', { name: 'Location preview' })
      .getByRole('button', { name: 'Keep following' })
      .click()
    await viewer.getByRole('button', { name: 'Save location' }).click()
    await expect(viewer.getByText('Seeing 1')).toBeVisible()
    await source.getByRole('button', { name: 'Sharing 1' }).click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText(
      '1 connected',
      { timeout: 30_000 },
    )
    await source.getByText('Connected viewers (1)').click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText('Connection ')
    await source.getByRole('button', { name: /Edit device name/ }).click()
    await source.getByRole('textbox', { name: 'Device name' }).fill('Friend phone')
    await source
      .getByRole('dialog', { name: 'Active shares' })
      .getByRole('button', { name: 'Save' })
      .click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText(
      'Friend phone',
    )
    await source
      .getByRole('dialog', { name: 'Active shares' })
      .getByRole('button', { name: 'Close' })
      .click()
    await source.getByRole('button', { name: 'Open menu' }).click()
    await source.getByRole('button', { name: 'P2P diagnostics' }).click()
    await expect(source.getByRole('dialog', { name: 'P2P diagnostics' })).toContainText('viewer')
    await expect(source.getByRole('dialog', { name: 'P2P diagnostics' })).toContainText(
      /viewer · (relay circuit|WebRTC)/,
    )
    await expect(source.getByRole('dialog', { name: 'P2P diagnostics' })).toContainText(
      /stream-open.*admitted|admitted.*stream-open/,
    )
    await expect(source.getByRole('dialog', { name: 'P2P diagnostics' })).not.toContainText('/ip4/')
    await source.getByRole('button', { name: 'Reveal peer IDs and addresses' }).click()
    await expect(source.getByRole('dialog', { name: 'P2P diagnostics' })).toContainText('/ip4/')
    await source
      .getByRole('dialog', { name: 'P2P diagnostics' })
      .getByRole('button', { name: 'Close' })
      .click()
    await viewer.getByRole('button', { name: 'Open menu' }).click()
    await viewer.getByRole('button', { name: 'Following (1)' }).click()
    await expect(
      viewer.getByRole('dialog', { name: 'Following' }).getByRole('button', {
        name: 'Show on map',
      }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(viewer.getByRole('status').last()).not.toContainText(
      'Waiting for the first location',
    )
    await viewer
      .getByRole('dialog', { name: 'Following' })
      .getByRole('button', { name: 'Close' })
      .click()
    await viewer.reload()
    await expect(viewer.getByText('Seeing 1')).toBeVisible({
      timeout: 30_000,
    })
    await source.reload()
    await expect(source.getByText('Sharing 1')).toBeVisible({ timeout: 30_000 })
    await expect(source.getByText('Your position ready')).toBeVisible({ timeout: 15_000 })
    await viewer.getByRole('button', { name: 'Open menu' }).click()
    await viewer.getByRole('button', { name: 'Following (1)' }).click()
    await expect(
      viewer.getByRole('dialog', { name: 'Following' }).getByRole('button', {
        name: 'Show on map',
      }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText('Last location')
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText(
      'Updates this session',
    )
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText('Following since')
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText('Time left')
    await viewer.getByRole('button', { name: /Edit nickname for/ }).click()
    await viewer.getByRole('textbox', { name: 'Your nickname' }).fill('Local friend')
    await viewer
      .getByRole('dialog', { name: 'Following' })
      .getByRole('button', { name: 'Save' })
      .click()
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText('Local friend')
    await viewer
      .getByRole('dialog', { name: 'Following' })
      .getByRole('button', { name: 'Close' })
      .click()
    await expect(source.getByRole('button', { name: 'Share location' })).toHaveCount(0)
    await source.getByRole('button', { name: 'Sharing 1' }).click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText(
      '1 connected',
      { timeout: 30_000 },
    )
    await source.getByText('Connected viewers (1)').click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText(
      'Friend phone',
    )
    await source
      .getByRole('dialog', { name: 'Active shares' })
      .getByRole('button', { name: 'Close' })
      .click()

    await source.getByRole('button', { name: 'Show sharing actions' }).click()
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('textbox', { name: 'Share a name' }).fill('Second')
    await source.getByRole('button', { name: 'Create private link' }).click()
    const secondUrl = await source.getByLabel('Share link').inputValue()
    await secondViewer.goto(secondUrl)
    await expect(secondViewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })

    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await source.getByRole('button', { name: 'Sharing 2' }).click()
    await source.getByRole('button', { name: 'Revoke link' }).first().click()
    await expect(viewer.locator('.toast')).toContainText('sender revoked your access', {
      timeout: 15_000,
    })
    await expect(viewer.getByRole('button', { name: 'Seeing 0' })).toBeVisible()
    await viewer.getByRole('button', { name: 'Seeing 0' }).click()
    const history = viewer.getByRole('dialog', { name: 'Following' })
    await expect(history).toContainText('Old seeing shares (1)')
    await expect(history).toContainText('Revoked by sender')
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText('1 connected')
    await source.getByRole('button', { name: 'Show link / QR' }).click()
    await source.getByRole('button', { name: 'Stop sharing' }).click()
  } finally {
    await secondViewerContext.close()
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('blocking one viewer device preserves the other and survives source reload', async ({
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
  const firstContext = await browser.newContext({ baseURL })
  const secondContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    const first = await firstContext.newPage()
    const second = await secondContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await first.goto(url)
    await expect(first.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await source.getByRole('button', { name: 'Sharing 1' }).click()
    const shares = source.getByRole('dialog', { name: 'Active shares' })
    await expect(shares).toContainText('1 connected', { timeout: 30_000 })
    await shares.getByText('Connected viewers (1)').click()
    await shares.getByRole('button', { name: /Edit device name/ }).click()
    await shares.getByRole('textbox', { name: 'Device name' }).fill('First device')
    await shares.getByRole('button', { name: 'Save' }).click()

    await second.goto(url)
    await expect(second.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(shares).toContainText('2 connected', { timeout: 30_000 })
    await shares.getByRole('button', { name: 'Block device First device' }).click()
    await expect(shares).toContainText('1 connected', { timeout: 30_000 })
    await expect(first.locator('.toast')).toContainText('sender revoked your access', {
      timeout: 15_000,
    })
    await expect
      .poll(() =>
        first.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.oldSeeing?.some(
            (share) => share.reason === 'revoked',
          )
        }),
      )
      .toBe(true)

    await source.reload()
    await expect(source.getByRole('button', { name: 'Sharing 1' })).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.shares[0]?.blockedPeerIds?.length
        }),
      )
      .toBe(1)
    await first.goto('/')
    await first.getByRole('button', { name: 'Show sharing actions' }).click()
    await first.getByRole('button', { name: 'Add location' }).click()
    await first.getByLabel('Paste location link').fill(url)
    await first.getByRole('button', { name: 'View location' }).click()
    await expect(first.locator('.toast')).toContainText('This location link has ended.', {
      timeout: 15_000,
    })
    await expect(source.getByRole('button', { name: 'Sharing 1' })).toBeVisible()
    await source.getByRole('button', { name: 'Sharing 1' }).click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText(
      '1 connected',
      {
        timeout: 30_000,
      },
    )
  } finally {
    await secondContext.close()
    await firstContext.close()
    await sourceContext.close()
  }
})

test('follows two independent sources and stops one without removing the other', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('The test requires a configured base URL.')

  await withTwoSources(browser, baseURL, {}, async ({ first, second, viewer }) => {
    await test.step('manage and stop one follow', async () => {
      await viewer.getByRole('button', { name: 'Open menu' }).click()
      await viewer.getByRole('button', { name: 'Following (2)' }).click()
      const following = viewer.getByRole('dialog', { name: 'Following' })
      await expect(following.getByText('River', { exact: true })).toBeVisible()
      await expect(following.getByText('Forest', { exact: true })).toBeVisible()
      await following.getByRole('button', { name: 'Show all on map' }).click()
      await expect(following).toHaveCount(0)
      await viewer.getByRole('button', { name: 'Open menu' }).click()
      await viewer.getByRole('button', { name: 'Following (2)' }).click()
      await following.getByRole('button', { name: 'Show on map' }).first().click()
      await expect(following).toHaveCount(0)
      await viewer.getByRole('button', { name: 'Open menu' }).click()
      await viewer.getByRole('button', { name: 'Following (2)' }).click()
      await following.getByRole('button', { name: 'Stop following' }).first().click()
      await first.getByRole('button', { name: 'Sharing 1' }).click()
      await expect(first.getByRole('dialog', { name: 'Active shares' })).toContainText(
        '0 connected',
      )
      await second.getByRole('button', { name: 'Sharing 1' }).click()
      await expect(second.getByRole('dialog', { name: 'Active shares' })).toContainText(
        '1 connected',
      )
      await expect(following.getByText('Forest', { exact: true })).toBeVisible()
    })
  })
})

test('independent links from one source use unlinkable source peer identities', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 48.1372, longitude: 11.5756 })
  await page.goto('/')

  const createLink = async (): Promise<string> => {
    const shareLocation = page.getByRole('button', { name: 'Share location' })
    if (!(await shareLocation.isVisible())) {
      await page.getByRole('button', { name: 'Show sharing actions' }).click()
    }
    await shareLocation.click()
    await page.getByRole('button', { name: 'Create private link' }).click()
    const url = await page.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    return url
  }

  const firstUrl = await createLink()
  const secondUrl = await createLink()
  const first = parseShareInvitation(firstUrl)
  const second = parseShareInvitation(secondUrl)
  expect(first.sourcePeerId).not.toBe(second.sourcePeerId)
  expect(first.addresses).not.toEqual(second.addresses)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Sharing 2' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Sharing 2' }).click()
  const links = await page
    .getByRole('dialog', { name: 'Active shares' })
    .getByRole('button', {
      name: 'Show link / QR',
    })
    .all()
  await links[0]!.click()
  const restoredUrl = await page.getByLabel('Share link').inputValue()
  expect(parseShareInvitation(restoredUrl).sourcePeerId).toBe(first.sourcePeerId)
})

test('a disconnected viewer learns revocation after the source restarts', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000)
  test.skip(testInfo.project.name !== 'desktop')
  const sourceContext = await browser.newContext({ baseURL })
  const viewerContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    let viewer = await viewerContext.newPage()
    await source.goto('/')
    await source.getByRole('button', { name: 'Share location' }).click()
    await source.getByRole('button', { name: 'Create private link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await viewer.goto(url)
    await viewer.getByRole('button', { name: 'Keep following' }).click({ timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Save location' }).click()
    await expect
      .poll(() =>
        viewer.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.followed?.length
        }),
      )
      .toBe(1)
    await viewer.close()
    await source.getByRole('button', { name: /Sharing 1/ }).click()
    await source.getByRole('button', { name: 'Revoke link' }).click()
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.oldSharing?.[0]?.reason
        }),
      )
      .toBe('revoked')
    await source.reload()
    await expect(source.getByRole('button', { name: 'Sharing 0' })).toBeVisible()
    viewer = await viewerContext.newPage()
    await viewer.goto('/')
    await expect(viewer.getByRole('button', { name: 'Seeing 0' })).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(
        () =>
          viewer.evaluate(async () => {
            const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
            return (await createBrowserPrivateStore().load())?.oldSeeing?.[0]?.reason
          }),
        { timeout: 30_000 },
      )
      .toBe('revoked')
    const access = await viewer.evaluate(async (url) => {
      const { probeEndedShare } = await import('../tests/fixtures/share-probe.ts')
      return probeEndedShare(url)
    }, url)
    expect(access.invalidProofDenied).toBe(true)
    expect(access.result).toMatchObject({ ended: true, reason: 'revoked' })
    expect(access.result).not.toHaveProperty('sessionId')
    expect(access.locationDenied).toBe(true)
    expect(access.returnDenied).toBe(true)
    const endedAcceptance = await viewer.evaluate(async (url) => {
      const { rejectEndedShare } = await import('../tests/fixtures/share-probe.ts')
      return rejectEndedShare(url)
    }, url)
    expect(endedAcceptance).toEqual({ rejected: true, received: 0, history: ['revoked'] })
    await viewer.getByRole('button', { name: 'Seeing 0' }).click()
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText(
      'Revoked by sender',
    )
    await expect(
      viewer.getByRole('button', { name: /Share approximate location for 1 hour back to/ }),
    ).toHaveCount(0)
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})
