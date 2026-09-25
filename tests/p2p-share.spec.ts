import { expect, test } from '@playwright/test'

import { parseShareInvitation } from '../src/sharing/shareLink.ts'

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
    await viewer.getByRole('button', { name: 'Share mine back' }).click()
    await expect(viewer.getByRole('dialog', { name: 'Share your location' })).toBeVisible()
    await viewer
      .getByRole('dialog', { name: 'Share your location' })
      .getByRole('button', { name: 'Close' })
      .click()
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
  } finally {
    await viewerContext.close()
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
    await expect(viewer.getByText('Location sharing ended.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText('1 connected')
    await source.getByRole('button', { name: 'Show link / QR' }).click()
    await source.getByRole('button', { name: 'Stop sharing' }).click()
  } finally {
    await secondViewerContext.close()
    await viewerContext.close()
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
  const viewerContext = await browser.newContext({ baseURL })
  const first = await firstContext.newPage()
  const second = await secondContext.newPage()
  const viewer = await viewerContext.newPage()

  try {
    const links = await test.step('create two source links', () =>
      Promise.all(
        (
          [
            [first, 'River'],
            [second, 'Forest'],
          ] as const
        ).map(async ([source, name]) => {
          await source.goto('/')
          await expect(source.getByRole('button', { name: 'Center on my location' })).toBeVisible()
          await source.getByRole('button', { name: 'Share location' }).click()
          await source.getByRole('textbox', { name: 'Share a name' }).fill(name)
          await source.getByRole('button', { name: 'Create private link' }).click()
          const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
          await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
          return url
        }),
      ))
    parseShareInvitation(links[1]!)

    await test.step('open first source', async () => {
      await viewer.goto(links[0]!)
      await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
        timeout: 30_000,
      })
      await expect(viewer.getByText('Seeing 1')).toBeVisible()
    })
    await test.step('open second source', async () => {
      await viewer.getByRole('button', { name: 'Open menu' }).click({ timeout: 5_000 })
      await viewer.getByRole('button', { name: 'Follow a link' }).click({ timeout: 5_000 })
      await viewer.getByRole('textbox', { name: 'Paste location link' }).fill(links[1]!)
      await viewer.getByRole('dialog').getByRole('button', { name: 'View location' }).click()
      await expect(viewer.getByText('Seeing 2')).toBeVisible({ timeout: 30_000 })
    })

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
  } finally {
    await viewerContext.close()
    await secondContext.close()
    await firstContext.close()
  }
})
