import { expect, test, type Page } from '@playwright/test'
import QRCode from 'qrcode'
import jsQR from 'jsqr'

import { parseShareInvitation } from '../src/sharing/shareLink.ts'
import {
  expandPeerDetails,
  openPeerFilterMenu,
  openPeerFilter,
  openPeerList,
  openShareCreator,
  saveLocationPreview,
} from './fixtures/peer-navigation.ts'
import { withTwoSources } from './fixtures/two-sources.ts'

test('synchronizes opted-in names independently and keeps reciprocal nicknames private', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { probePeerNames } = await import('../tests/fixtures/share-probe.ts')
    return probePeerNames()
  })
  expect(result).toEqual({
    defaultNames: false,
    initialDisplayName: 'Link label',
    adoptedDisplayName: 'Alice',
    linkNamePreserved: true,
    linkNameAdoptedAfterClear: true,
    oneDirection: 'Alice',
    reverseInitiallyPrivate: true,
    reverseOptIn: 'Bob',
    viewerUpdatePending: true,
    viewerUpdateAdopted: true,
    privateNickname: 'Mum',
    sharedUpdate: 'Alicia',
    linkNameRestoredAfterClear: true,
  })
})

test('revocation during viewer admission preserves ended history', async ({ page }) => {
  test.setTimeout(90_000)
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

test('keeps ended sharing history with each authenticated peer across links', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('A base URL is required.')
  const readCleanupState = (page: Page) =>
    page.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      const state = await createBrowserPrivateStore().load()
      return {
        active: state?.shares.length,
        history: state?.oldSharing?.length,
        cleared: state?.oldSharing?.filter((record) => record.cleared).length,
        endpoints: state?.endedShares?.length,
      }
    })
  const sourceContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 48.1372, longitude: 11.5756 },
    permissions: ['geolocation'],
  })
  const firstViewerContext = await browser.newContext({ baseURL })
  const secondViewerContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    const firstViewer = await firstViewerContext.newPage()
    const secondViewer = await secondViewerContext.newPage()
    await source.goto('/')
    await expect(source.getByRole('button', { name: 'Center on my location' })).toBeVisible()

    await openShareCreator(source)
    await source.getByLabel('Share a name').fill('Trip A')
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create location link' }).click()
    const firstUrl = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await Promise.all(
      [firstViewer, secondViewer].map(async (viewer) => {
        await viewer.goto(firstUrl)
        await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
          timeout: 30_000,
        })
        await saveLocationPreview(viewer)
      }),
    )

    await source.locator('.dock-peers').click()
    const peers = source.locator('.peer-list')
    await expect(peers.locator('.peer-list__item')).toHaveCount(2, { timeout: 30_000 })
    await expect(peers.locator('.peer-list__summary-name')).toHaveText([
      'Connected peer',
      'Connected peer',
    ])
    await expect(peers.locator('.peer-viewer-details summary').first()).toContainText(
      'Connected viewers (2)',
    )

    await peers.getByRole('button', { name: 'Close' }).click()
    await openShareCreator(source)
    await source.getByLabel('Share a name').fill('Trip B')
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create location link' }).click()
    const secondUrl = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await firstViewer.goto('about:blank')
    await firstViewer.goto(secondUrl)
    await expect(firstViewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await saveLocationPreview(firstViewer)
    const viewerPeers = await openPeerFilter(firstViewer, 'Viewing')
    const viewerPeer = viewerPeers.locator('.peer-list__item').first()
    const mapAction = viewerPeers.locator('.peer-list__map-action')
    await expect(mapAction).toBeVisible()
    await viewerPeer.locator('.peer-list__summary').focus()
    await firstViewer.keyboard.press('Tab')
    await expect(mapAction).toBeFocused()
    await firstViewer.evaluate(async () => {
      const moduleUrl = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/node_modules/.vite/deps/maplibre-gl.js'))?.name
      if (!moduleUrl) throw new Error('MapLibre module was not loaded.')
      const maplibre = await import(/* @vite-ignore */ moduleUrl)
      const originalFitBounds = maplibre.Map.prototype.fitBounds
      const testWindow = window as typeof window & { peerCameraCalls: unknown[] }
      testWindow.peerCameraCalls = []
      maplibre.Map.prototype.fitBounds = function (bounds: unknown) {
        testWindow.peerCameraCalls.push(bounds)
        return originalFitBounds.call(this, bounds)
      }
    })
    const expandedBeforeMapAction = await viewerPeer.evaluate(
      (item) => (item as HTMLDetailsElement).open,
    )
    expect(expandedBeforeMapAction).toBe(false)
    await viewerPeer.evaluate((item) => {
      ;(window as Window & { peerToggleCount?: number }).peerToggleCount = 0
      item.addEventListener('toggle', () => {
        const target = window as Window & { peerToggleCount?: number }
        target.peerToggleCount = (target.peerToggleCount ?? 0) + 1
      })
    })
    await firstViewer.keyboard.press('Enter')
    await expect(firstViewer.getByRole('dialog', { name: 'Following' })).toHaveCount(0)
    expect(
      await firstViewer.evaluate(
        () => (window as Window & { peerToggleCount?: number }).peerToggleCount ?? 0,
      ),
    ).toBe(0)
    await expect
      .poll(() =>
        firstViewer.evaluate(
          () => (window as typeof window & { peerCameraCalls: unknown[] }).peerCameraCalls.length,
        ),
      )
      .toBe(1)

    await source.locator('.dock-peers').click()
    const activePeer = peers.locator('.peer-list__item').filter({ hasText: 'Trip B' })
    await expect(activePeer).toHaveCount(1, { timeout: 30_000 })
    const oldLinkPeer = peers
      .locator('.peer-list__item')
      .filter({ hasText: 'Trip A' })
      .filter({ hasNotText: 'Trip B' })
    await expect(oldLinkPeer).toHaveCount(1)
    await expandPeerDetails(oldLinkPeer)
    await oldLinkPeer.getByRole('button', { name: 'Revoke link' }).click()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1', { timeout: 30_000 })

    const authenticatedEndedRecords = await source.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      const history = (await createBrowserPrivateStore().load())?.oldSharing ?? []
      return {
        distinctPeerCount: new Set(history.flatMap(({ peerId }) => (peerId ? [peerId] : []))).size,
        records: history.map(({ peerId, reason, endedAt }) => ({
          hasPeer: Boolean(peerId),
          reason,
          hasEndTime: endedAt > 0,
        })),
      }
    })
    expect(authenticatedEndedRecords.distinctPeerCount).toBe(2)
    expect(authenticatedEndedRecords.records).toHaveLength(2)
    expect(
      authenticatedEndedRecords.records.every(
        ({ hasPeer, reason, hasEndTime }) => hasPeer && reason === 'revoked' && hasEndTime,
      ),
    ).toBe(true)

    if (!(await activePeer.evaluate((item) => (item as HTMLDetailsElement).open))) {
      await activePeer.locator('.peer-list__summary').click()
    }
    await expandPeerDetails(activePeer)
    await expect(activePeer.getByRole('button', { name: 'Show link / QR' })).toBeVisible()
    await expect(activePeer.getByRole('button', { name: 'Revoke link' })).toBeVisible()
    await expect(activePeer.locator('.peer-history-item')).toContainText('Trip A')
    await activePeer.locator('.peer-viewer-details summary').click()
    await activePeer.getByRole('button', { name: /Edit device name for connection/ }).click()
    await activePeer.getByRole('textbox', { name: 'Device name' }).fill('Former peer')
    await activePeer.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(activePeer.locator('.peer-list__summary-name')).toHaveText('Former peer')

    await peers.getByRole('button', { name: 'Close' }).click()
    await openShareCreator(source)
    await source.getByLabel('Share a name').fill('Unclaimed link')
    await source.getByRole('button', { name: 'Create location link' }).click()
    const shareReady = source.getByRole('dialog', { name: 'Share this QR code' })
    await expect(shareReady).toBeVisible()
    await shareReady.getByRole('button', { name: 'Close' }).click()
    await source.locator('.dock-peers').click()
    const unclaimedPeer = peers.locator('.peer-list__item').filter({ hasText: 'Unclaimed link' })
    await expect(unclaimedPeer).toHaveCount(1)
    await expandPeerDetails(unclaimedPeer)
    await unclaimedPeer.getByRole('button', { name: 'Revoke link' }).click()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1', { timeout: 30_000 })

    const endedRecords = await source.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      const history = (await createBrowserPrivateStore().load())?.oldSharing ?? []
      return history.map(({ peerId, reason, endedAt }) => ({
        hasPeer: Boolean(peerId),
        reason,
        hasEndTime: endedAt > 0,
      }))
    })
    expect(endedRecords).toHaveLength(3)
    expect(endedRecords.filter(({ hasPeer }) => hasPeer)).toHaveLength(2)
    expect(endedRecords.filter(({ hasPeer }) => !hasPeer)).toEqual([
      { hasPeer: false, reason: 'revoked', hasEndTime: true },
    ])

    await openPeerFilterMenu(peers.page())
    const endedToggle = peers.getByLabel('Show ended')
    await expect(endedToggle).not.toBeChecked()
    await expect(peers.locator('.peer-list__item')).toHaveCount(1)
    await endedToggle.check()
    await expect(peers.locator('.peer-list__item')).toHaveCount(3)
    await expect(peers.locator('.peer-list__item').filter({ hasText: 'Trip A' })).toHaveCount(2)
    await expect(peers.locator('.peer-list__summary-name')).toHaveText([
      'Former peer',
      'Former peer',
      'Unclaimed link',
    ])
    await expect(peers.locator('.peer-list__item').filter({ hasText: 'Trip B' })).toContainText(
      'Trip A',
    )

    await openPeerFilterMenu(peers.page())
    await peers.getByRole('button', { name: 'Sharing', exact: true }).click()
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toBeVisible()
    await expect(peers.locator('.peer-list__item')).toHaveCount(3)
    await openPeerFilterMenu(peers.page())
    await peers.getByRole('button', { name: 'Viewing', exact: true }).click()
    await expect(source.getByRole('dialog', { name: 'Following' })).toBeVisible()
    await expect(peers.locator('.peer-list__item')).toHaveCount(0)
    await openPeerFilterMenu(peers.page())
    await peers.getByRole('button', { name: 'Both', exact: true }).click()
    await expect(source.getByRole('dialog', { name: 'Peers' })).toBeVisible()
    await expect(peers.locator('.peer-list__item')).toHaveCount(0)
    await openPeerFilterMenu(peers.page())
    await peers.getByRole('button', { name: 'All', exact: true }).click()
    await expect(peers.locator('.peer-list__item')).toHaveCount(3)
    await peers.getByRole('button', { name: 'Close' }).click()

    await source.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      const history = (await createBrowserPrivateStore().load())?.oldSharing ?? []
      sessionStorage.setItem(
        'constellation-test-history-peers',
        JSON.stringify(history.map(({ peerId }) => peerId ?? null).sort()),
      )
    })
    await source.reload()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1', { timeout: 30_000 })
    const restoredHistory = await source.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      const history = (await createBrowserPrivateStore().load())?.oldSharing ?? []
      const previousPeerIds = JSON.parse(
        sessionStorage.getItem('constellation-test-history-peers') ?? '[]',
      ) as (string | null)[]
      sessionStorage.removeItem('constellation-test-history-peers')
      return {
        sameIdentities:
          JSON.stringify(previousPeerIds) ===
          JSON.stringify(history.map(({ peerId }) => peerId ?? null).sort()),
        records: history.map(({ peerId, reason, endedAt }) => ({
          hasPeer: Boolean(peerId),
          reason,
          hasEndTime: endedAt > 0,
        })),
      }
    })
    expect(restoredHistory.sameIdentities).toBe(true)
    expect(restoredHistory.records).toEqual(endedRecords)
    const restoredPeers = await openPeerFilter(source, 'All')
    await openPeerFilterMenu(source)
    await restoredPeers.getByLabel('Show ended').check()
    await expect(restoredPeers.locator('.peer-list__item')).toHaveCount(3)
    await restoredPeers.getByRole('button', { name: 'Clear old', exact: true }).click()
    await expect(restoredPeers.locator('.peer-list__item')).toHaveCount(1)
    const cleaned = await readCleanupState(source)
    expect(cleaned).toEqual({ active: 1, history: 3, cleared: 2, endpoints: 2 })
    await source.reload()
    const cleanedPeers = await openPeerFilter(source, 'All')
    await openPeerFilterMenu(source)
    await cleanedPeers.getByLabel('Show ended').check()
    // A restored multi-viewer link may have a separate waiting row until its viewer reconnects.
    await expect(cleanedPeers.locator('.peer-history-item')).toHaveCount(1)
    await expect(cleanedPeers.locator('.peer-history-item')).toContainText('Trip A')
    await expect(
      cleanedPeers.locator('.peer-list__item').filter({ hasText: 'Unclaimed link' }),
    ).toHaveCount(0)
    expect(await readCleanupState(source)).toEqual(cleaned)
  } finally {
    await Promise.all([
      secondViewerContext.close(),
      firstViewerContext.close(),
      sourceContext.close(),
    ])
  }
})

test('single-recipient links wait for source approval before revealing a location', async ({
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
  const firstViewerContext = await browser.newContext({
    baseURL,
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: ['geolocation'],
  })
  const forwardedViewerContext = await browser.newContext({ baseURL })
  try {
    const source = await sourceContext.newPage()
    await source.goto('/')
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    const shareReady = source.getByRole('dialog', { name: 'Share this QR code' })
    await expect(shareReady).toBeVisible()

    const firstViewer = await firstViewerContext.newPage()
    await firstViewer.goto(url)
    const request = source.getByRole('region', { name: 'Viewer access request' })
    await expect(request).toBeVisible({ timeout: 30_000 })
    await expect(shareReady).toHaveCount(0)

    const firstFollowing = await openPeerFilter(firstViewer, 'Viewing')
    await expect(firstFollowing).toContainText('Waiting for sender approval')
    await expect(firstFollowing).toContainText('Last location: not received')

    await request.getByRole('button', { name: 'Approve this device' }).click()
    await expect
      .poll(() => firstFollowing.textContent(), { timeout: 30_000 })
      .not.toContain('Last location: not received')
    await expect(firstFollowing).not.toContainText('Waiting for sender approval')

    const forwardedViewer = await forwardedViewerContext.newPage()
    await forwardedViewer.goto(url)
    const forwardedFollowing = await openPeerFilter(forwardedViewer, 'Viewing')
    await expect(forwardedFollowing).toContainText('Access not approved')
    await expect(forwardedFollowing).toContainText('Last location: not received')
    await expect(source.getByRole('region', { name: 'Viewer access request' })).toHaveCount(0)
  } finally {
    await forwardedViewerContext.close()
    await firstViewerContext.close()
    await sourceContext.close()
  }
})

test('share-back preserves its sender and options through cancellation and a failed creation retry', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error('The test requires a configured base URL.')
  await withTwoSources(
    browser,
    baseURL,
    { viewport: testInfo.project.use.viewport },
    async ({ first, second, viewer }) => {
      await saveLocationPreview(viewer)
      const openReturnForm = async () => {
        const list = await openPeerFilter(viewer, 'Viewing')
        const peer = list.locator('.peer-list__item').filter({ hasText: 'River' })
        await expandPeerDetails(peer)
        await peer.getByRole('button', { name: 'Share back to River', exact: true }).click()
        return viewer.getByRole('dialog', { name: 'Share your location' })
      }
      const form = await openReturnForm()
      await expect(form).toContainText('Sharing back to River')
      await form.getByRole('button', { name: 'Close', exact: true }).click()
      const readShareCount = () =>
        viewer.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.shares.length ?? 0
        })
      expect(await readShareCount()).toBe(0)
      await expect(first.getByRole('region', { name: 'Return location offered' })).toHaveCount(0)

      await openReturnForm()
      await form.getByLabel('Share a name', { exact: true }).fill('Synthetic Return')
      await form.getByRole('button', { name: /Very coarse/ }).click()
      await form.getByRole('button', { name: 'Until stopped', exact: true }).click()
      await expect(form.getByRole('button', { name: 'Create location link' })).toBeDisabled()
      await form.getByRole('button', { name: '8 hours', exact: true }).click()
      await viewer.evaluate(() => {
        const original = Reflect.get(IDBObjectStore.prototype, 'put')
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.name === 'secrets' && key === 'state') {
            IDBObjectStore.prototype.put = original
            throw new Error('Synthetic share creation storage failure')
          }
          return original.call(this, value, key)
        }
      })
      await form.getByRole('button', { name: 'Create location link' }).click()
      await expect(viewer.locator('.toast')).toContainText(
        'Synthetic share creation storage failure',
      )
      await expect(form).toContainText('Sharing back to River')
      await expect(form.getByText('Viewers', { exact: true })).toHaveCount(0)
      await expect(form.getByLabel('Share a name', { exact: true })).toHaveValue('Synthetic Return')
      await expect(form.getByRole('button', { name: /Very coarse/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(form.getByRole('button', { name: '8 hours', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(await readShareCount()).toBe(0)
      await expect(first.getByRole('region', { name: 'Return location offered' })).toHaveCount(0)

      const confirmedAt = Date.now()
      await form.getByRole('button', { name: 'Create location link' }).click()
      await expect(form).toHaveCount(0)
      await expect(first.getByRole('region', { name: 'Return location offered' })).toBeVisible({
        timeout: 30_000,
      })
      await expect(second.getByRole('region', { name: 'Return location offered' })).toHaveCount(0)
      await expect(viewer.getByRole('img', { name: 'Location share QR code' })).toHaveCount(0)
      const result = await viewer.evaluate(async () => {
        const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
        const { parseShareInvitation } = await import('../src/sharing/shareLink.ts')
        const saved = (await createBrowserPrivateStore().load())!
        const share = saved.shares[0]!
        const original = saved.followed.find((follow) => follow.sourceName === 'River')!
        return {
          count: saved.shares.length,
          name: share.name,
          precision: share.precision,
          capacity: share.capacity,
          recipientMatches: share.approvedPeerId === parseShareInvitation(original.url).ownerPeerId,
          publication: share.publication,
          globalPublication: saved.sharingBehavior?.publication,
          expiresAt: parseShareInvitation(share.url).expiresAt,
        }
      })
      expect(result).toMatchObject({
        count: 1,
        name: 'Synthetic Return',
        precision: 'very-coarse',
        capacity: 1,
        recipientMatches: true,
        publication: 'foreground',
        globalPublication: 'foreground',
      })
      expect(result.expiresAt).toBeGreaterThanOrEqual(confirmedAt + 8 * 60 * 60 * 1_000)
      expect(result.expiresAt).toBeLessThan(Date.now() + 8 * 60 * 60 * 1_000)
      await openReturnForm()
      const originalPeers = await openPeerFilter(first, 'Sharing')
      const originalPeer = originalPeers.locator('.peer-list__item').first()
      await expandPeerDetails(originalPeer)
      await originalPeer.getByRole('button', { name: 'Revoke link', exact: true }).click()
      await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1', { timeout: 30_000 })
      await form.getByRole('button', { name: 'Create location link' }).click()
      await expect(viewer.locator('.toast')).toContainText('no longer available for sharing back')
      await expect(form).toContainText('Only this sender receives the private offer')
      expect(await readShareCount()).toBe(1)
      await form.getByRole('button', { name: 'Close', exact: true }).click()
    },
    { afterFirstFollow: saveLocationPreview },
  )
})

test('return consent applies to every viewer of the same original link', async ({
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
    await openShareCreator(source)
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await expect(source.getByRole('img', { name: 'Location share QR code' })).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    )
    await expect(source.getByRole('button', { name: 'Copy link' })).toBeVisible()
    await expect(source.getByRole('button', { name: 'Share via system menu' })).toBeVisible()
    await expect(source.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0)
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1')

    await viewer.goto(url)
    await viewer.getByRole('button', { name: 'Keep following' }).click({ timeout: 30_000 })
    await viewer.getByRole('button', { name: 'Save location' }).click()
    const returnInvitation = viewer.getByRole('region', { name: 'Share back invitation' })
    await returnInvitation.getByRole('button', { name: 'Share back' }).click()
    const returnForm = viewer.getByRole('dialog', { name: 'Share your location' })
    await expect(returnForm).toContainText('Only this sender receives the private offer')
    await expect(returnForm.getByText('Viewers')).toHaveCount(0)
    await expect(
      returnForm.getByRole('button', { name: /While app is open|In background/ }),
    ).toHaveCount(0)
    await returnForm.getByRole('button', { name: 'Create location link' }).click()
    await expect(viewer.getByRole('img', { name: 'Location share QR code' })).toHaveCount(0)

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
    await openPeerFilter(secondViewer, 'Viewing')
    await expandPeerDetails(secondViewer.locator('.peer-list__item').first())
    const secondReturnForm = secondViewer.getByRole('button', { name: /Share back to/ })
    await secondReturnForm.click()
    const secondShareForm = secondViewer.getByRole('dialog', { name: 'Share your location' })
    await expect(secondShareForm).toContainText('Only this sender receives the private offer')
    await secondShareForm.getByRole('button', { name: /Very coarse/ }).click()
    await secondShareForm.getByRole('button', { name: '8 hours' }).click()
    await expect(secondShareForm.getByRole('button', { name: /Very coarse/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(secondShareForm.getByRole('button', { name: '8 hours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(secondShareForm.getByText('Viewers')).toHaveCount(0)
    await secondShareForm.getByRole('button', { name: 'Create location link' }).click()
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.returnOffers?.length
        }),
      )
      .toBe(2)
    await offer.getByRole('button', { name: 'Accept share-backs' }).click()
    await expect
      .poll(
        () =>
          source.evaluate(async () => {
            const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
            return (await createBrowserPrivateStore().load())?.approvedReturnLinks?.length
          }),
        { timeout: 30_000 },
      )
      .toBe(1)
    await expect(source.locator('.dock-peers')).toContainText('Seeing 2', { timeout: 30_000 })
    await expect(offer).toHaveCount(0)
    const peerList = await openPeerList(source)
    await expect(peerList.locator('.peer-list__item')).toHaveCount(2)
    await openPeerFilterMenu(peerList.page())
    await peerList.getByRole('button', { name: 'All' }).click()
    await expect(peerList.locator('.peer-list__item')).toHaveCount(2)
    await openPeerFilterMenu(peerList.page())
    await peerList.getByRole('button', { name: 'Both' }).click()
    const mutualPeer = peerList.locator('.peer-list__item')
    await expect(mutualPeer).toHaveCount(2)
    await expect(mutualPeer.first().locator('.peer-list__summary')).toContainText(
      'Sharing and viewing',
    )
    await expandPeerDetails(mutualPeer.first())
    await expect(mutualPeer.first()).toContainText('Connected viewers (2)')
    await peerList.getByRole('button', { name: 'Close' }).click()

    const thirdViewer = await thirdViewerContext.newPage()
    await thirdViewer.goto(url)
    await expect(thirdViewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await openPeerFilter(thirdViewer, 'Viewing')
    await expandPeerDetails(thirdViewer.locator('.peer-list__item').first())
    await thirdViewer.getByRole('button', { name: /Share back to/ }).click()
    const thirdShareForm = thirdViewer.getByRole('dialog', { name: 'Share your location' })
    await expect(thirdShareForm).toContainText('Only this sender receives the private offer')
    await thirdShareForm.getByRole('button', { name: 'Create location link' }).click()
    await expect(source.locator('.dock-peers')).toContainText('Seeing 3', { timeout: 30_000 })
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
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    const displayedQr = await source.getByAltText('Location share QR code').evaluate((image) => {
      const element = image as HTMLImageElement
      const canvas = document.createElement('canvas')
      canvas.width = element.naturalWidth
      canvas.height = element.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(element, 0, 0)
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
      }
    })
    expect(displayedQr.width).toBeGreaterThanOrEqual(500)
    expect(
      jsQR(new Uint8ClampedArray(displayedQr.pixels), displayedQr.width, displayedQr.height)?.data,
    ).toBe(url)
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
        get: () => 1920,
      })
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
        configurable: true,
        get: () => 1080,
      })
      const cameraTestWindow = window as typeof window & {
        scannedFrameSizes: Array<[number, number]>
      }
      cameraTestWindow.scannedFrameSizes = []
      const matrixSize = Math.sqrt(qrModules.length)
      const nativeGetContext = Object.getOwnPropertyDescriptor(
        HTMLCanvasElement.prototype,
        'getContext',
      )?.value as (this: HTMLCanvasElement, ...args: unknown[]) => RenderingContext | null
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
          if (contextId !== '2d' || this.width !== 1280 || this.height !== 720) {
            return Reflect.apply(nativeGetContext, this, [contextId, ...args])
          }
          cameraTestWindow.scannedFrameSizes.push([this.width, this.height])
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
    const peerList = await openPeerList(viewer)
    await peerList.getByRole('button', { name: 'Add peer' }).click()
    await viewer.getByRole('button', { name: 'Scan QR code' }).click()
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    expect(
      await viewer.evaluate(
        () => (window as typeof window & { scannedFrameSizes: number[][] }).scannedFrameSizes[0],
      ),
    ).toEqual([1280, 720])
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
    await openShareCreator(source)
    await source.getByRole('button', { name: /Very coarse/ }).click()
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    const broadState = () =>
      source.evaluate(async () => {
        const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
        const share = (await createBrowserPrivateStore().load())?.shares[0]
        return { precision: share?.precision, radiusMeters: share?.approximation?.radiusMeters }
      })
    await expect.poll(broadState).toEqual({ precision: 'very-coarse', radiusMeters: 20_000 })

    await source.reload()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1')
    await expect.poll(broadState).toEqual({ precision: 'very-coarse', radiusMeters: 20_000 })

    await viewer.goto(url)
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    const request = source.getByRole('region', { name: 'Viewer access request' })
    await expect(request).toBeVisible({ timeout: 30_000 })
    await request.getByRole('button', { name: 'Approve this device' }).click()
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.shares[0]?.approvedPeerId
        }),
      )
      .toBeTruthy()
    await openPeerFilter(viewer, 'Viewing')
    await expandPeerDetails(viewer.locator('.peer-list__item').first())
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
  test.setTimeout(90_000)
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
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })

    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await viewer.goto(url)
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    const request = source.getByRole('region', { name: 'Viewer access request' })
    await expect(request).toBeVisible({ timeout: 30_000 })
    await request.getByRole('button', { name: 'Approve this device' }).click()
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.shares[0]?.approvedPeerId
        }),
      )
      .toBeTruthy()
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
    const returnInvitation = viewer.getByRole('region', { name: 'Share back invitation' })
    await expect(returnInvitation).toContainText('Share yours back', { timeout: 30_000 })
    await returnInvitation.getByRole('button', { name: 'Not now' }).click()
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1')
    await expect
      .poll(() =>
        viewer.evaluate(
          () => (window as typeof window & { ownGpsRequests: number }).ownGpsRequests,
        ),
      )
      .toBe(1)
    const outboundShares = await viewer.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      return (await createBrowserPrivateStore().load())?.shares.length
    })
    expect(outboundShares).toBe(0)
    const returnOffers = await source.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      return (await createBrowserPrivateStore().load())?.returnOffers?.length ?? 0
    })
    expect(returnOffers).toBe(0)
    await viewer.reload()
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1', { timeout: 30_000 })
    const follows = await openPeerFilter(viewer, 'Viewing')
    await expect(follows).toContainText('My friend')
    await expect(follows.getByRole('button', { name: /Share approximate location/ })).toHaveCount(0)
    await expect(viewer.getByRole('dialog', { name: 'Following' })).toContainText('Saved')
    await expandPeerDetails(viewer.locator('.peer-list__item').first())
    await expect(
      viewer
        .getByRole('dialog', { name: 'Following' })
        .getByRole('button', { name: /Share back to/ }),
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
      await openShareCreator(source)
      await source.getByRole('button', { name: 'Create location link' }).click()
      const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
      await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      return url
    }

    const firstUrl = await createLink()
    await openPeerList(source)
    const secondUrl = await createLink()
    const first = parseShareInvitation(firstUrl)
    const second = parseShareInvitation(secondUrl)

    expect(first.sourcePeerId).not.toBe(second.sourcePeerId)
    expect(first.addresses).not.toEqual(second.addresses)
    expect(first.addresses.every((address) => address.includes(first.sourcePeerId))).toBe(true)
    expect(second.addresses.every((address) => address.includes(second.sourcePeerId))).toBe(true)

    await source.reload()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 2', { timeout: 30_000 })
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
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await first.goto(url)
    await expect(first.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    const firstRequest = source.getByRole('region', { name: 'Viewer access request' })
    await expect(firstRequest).toBeVisible({ timeout: 30_000 })
    await firstRequest.getByRole('button', { name: 'Approve this device' }).click()
    await second.goto(url)
    const deniedPreview = second.getByRole('region', { name: 'Location preview' })
    await expect(deniedPreview).toContainText('The sender did not approve this device.')
    await expect(deniedPreview).toContainText('No location is being received.')
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
  test.setTimeout(180_000)
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
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
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
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1')
    await sourceContext.setGeolocation({ latitude: 48.1373, longitude: 11.5757 })
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1', {
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
    const request = source.getByRole('region', { name: 'Viewer access request' })
    await expect(request).toBeVisible({ timeout: 30_000 })
    await request.getByRole('button', { name: 'Approve this device' }).click()
    await viewer
      .getByRole('region', { name: 'Location preview' })
      .getByRole('button', { name: 'Keep following' })
      .click()
    await viewer.getByRole('button', { name: 'Save location' }).click()
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1')
    await openPeerFilter(source, 'Sharing')
    await expandPeerDetails(source.locator('.peer-list__item').first())
    await expect(source.getByRole('dialog', { name: 'Active shares' })).toContainText(
      '1 connected',
      { timeout: 30_000 },
    )
    await expect(source.getByText('Connected viewers (1)')).toBeVisible({ timeout: 30_000 })
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
    await openPeerFilter(viewer, 'Viewing')
    await expandPeerDetails(viewer.locator('.peer-list__item').first())
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
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1', {
      timeout: 30_000,
    })
    await source.reload()
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1', { timeout: 30_000 })
    await expect(source.getByText('Your position ready')).toBeVisible({ timeout: 15_000 })
    await openPeerFilter(viewer, 'Viewing')
    await expandPeerDetails(viewer.locator('.peer-list__item').first())
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
    await openPeerFilter(source, 'Sharing')
    await expandPeerDetails(source.locator('.peer-list__item').first())
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

    await openPeerList(source)
    await openShareCreator(source)
    await source.getByRole('textbox', { name: 'Share a name' }).fill('Second')
    await source.getByRole('button', { name: 'Create location link' }).click()
    const secondUrl = await source.getByLabel('Share link').inputValue()
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await secondViewer.goto(secondUrl)
    await expect(secondViewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    const secondRequest = source.getByRole('region', { name: 'Viewer access request' })
    await expect(secondRequest).toBeVisible({ timeout: 30_000 })
    await secondRequest.getByRole('button', { name: 'Approve this device' }).click()

    await openPeerFilter(source, 'Sharing')
    const originalSharePeer = source
      .getByRole('dialog', { name: 'Active shares' })
      .locator('.peer-list__item')
      .filter({ hasText: 'Friend phone' })
    await expect(originalSharePeer).toHaveCount(1)
    if (!(await originalSharePeer.evaluate((peer) => (peer as HTMLDetailsElement).open))) {
      await originalSharePeer.locator('.peer-list__summary').click()
    }
    await expect(originalSharePeer).toContainText('Connected viewers (1)', { timeout: 30_000 })
    await expandPeerDetails(originalSharePeer)
    await originalSharePeer.getByRole('button', { name: 'Revoke link' }).click()
    await expect(viewer.locator('.toast')).toContainText(
      'The sender revoked your access to this location.',
      { timeout: 15_000 },
    )
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 0')
    await openPeerFilter(viewer, 'Viewing')
    const history = viewer.locator('.peer-list')
    await openPeerFilterMenu(history.page())
    await expect(history.getByLabel('Show ended')).not.toBeChecked()
    await expect(history.locator('.peer-list__item')).toHaveCount(0)
    await openPeerFilterMenu(history.page())
    await history.getByLabel('Show ended').check()
    await expect(history.locator('.peer-list__item')).toHaveCount(1)
    await expect(history).toContainText('Viewed · revoked')
    const remainingShare = source.getByRole('dialog', { name: 'Active shares' })
    await expect(remainingShare).toContainText('0 connected')
    await expect(remainingShare).toContainText('Waiting for a viewer')
    await expandPeerDetails(source.locator('.peer-list__item').first())
    await source.getByRole('button', { name: 'Show link / QR' }).click()
    await expect(source.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0)
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await openPeerFilter(source, 'Sharing')
    await expandPeerDetails(source.locator('.peer-list__item').first())
    await source.getByRole('button', { name: 'Revoke link' }).click()
    await expect
      .poll(
        () =>
          source.evaluate(async () => {
            const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
            return (await createBrowserPrivateStore().load())?.oldSharing?.length
          }),
        { timeout: 15_000 },
      )
      .toBe(2)
    await expect(source.locator('.dock-peers')).toContainText('Sharing 0')
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
    await openShareCreator(source)
    await source.getByRole('button', { name: '10', exact: true }).click()
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await first.goto(url)
    await expect(first.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    await openPeerFilter(source, 'Sharing')
    const shares = source.getByRole('dialog', { name: 'Active shares' })
    await expect(shares).toContainText('1 connected', { timeout: 30_000 })
    await expandPeerDetails(source.locator('.peer-list__item').first())
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
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1', { timeout: 30_000 })
    await expect
      .poll(() =>
        source.evaluate(async () => {
          const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
          return (await createBrowserPrivateStore().load())?.shares[0]?.blockedPeerIds?.length
        }),
      )
      .toBe(1)
    await first.goto('/')
    await openPeerList(first)
    await first.locator('.peer-list').getByRole('button', { name: 'Add peer' }).click()
    await first.getByLabel('Paste location link').fill(url)
    await first.getByRole('button', { name: 'View location' }).click()
    await expect(first.locator('.toast')).toContainText('This location link has ended.')
    // Also exercise the sender's persisted block when this same synthetic viewer has no local
    // terminal history (for example, it missed the final notice). Preserve its private identity.
    await first.evaluate(async () => {
      const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
      const store = createBrowserPrivateStore()
      const state = await store.load()
      if (!state) throw new Error('The synthetic viewer identity was not persisted.')
      await store.save({ ...state, oldSeeing: [], followed: [] })
    })
    await first.goto('about:blank')
    await first.goto(url)
    await expect(first.locator('.toast')).toContainText(
      'The sender did not approve this device for the location share.',
      {
        timeout: 15_000,
      },
    )
    await expect(source.locator('.dock-peers')).toContainText('Sharing 1')
    await openPeerFilter(source, 'Sharing')
    await expandPeerDetails(source.locator('.peer-list__item').first())
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
  test.setTimeout(120_000)
  test.skip(testInfo.project.name !== 'desktop')
  if (!baseURL) throw new Error('The test requires a configured base URL.')

  await withTwoSources(
    browser,
    baseURL,
    {},
    async ({ first, second, viewer }) => {
      await test.step('manage and stop one follow', async () => {
        const following = await openPeerFilter(viewer, 'Viewing')
        const followRows = following.locator('.peer-list__item')
        await expect(followRows).toHaveCount(2, { timeout: 30_000 })
        await expandPeerDetails(followRows.nth(0))
        await expandPeerDetails(followRows.nth(1))
        const savedPeer = followRows.filter({ hasText: '· Saved' })
        const previewPeer = followRows.filter({ hasText: '· Preview' })
        await expect(savedPeer).toHaveCount(1)
        await expect(previewPeer).toHaveCount(1)
        // The fixture saves the first follow before creating the second preview.
        const offlineSource = second
        const remainingSource = first

        const readStopState = (page: Page) =>
          page.evaluate(async () => {
            const { createBrowserPrivateStore } = await import('../src/sharing/privateStore.ts')
            const state = await createBrowserPrivateStore().load()
            return {
              followedCount: state?.followed?.length ?? 0,
              pendingStopCount: state?.pendingStopNotices?.length ?? 0,
              stoppedViewers: (state?.stoppedViewers ?? []).map(({ recordedAt, dismissed }) => ({
                recordedAt,
                dismissed: dismissed === true,
              })),
            }
          })

        await offlineSource.goto('about:blank')
        await offlineSource.goto('/')
        await expect(offlineSource.locator('.dock-peers')).toContainText('Sharing 1', {
          timeout: 30_000,
        })
        expect((await readStopState(offlineSource)).stoppedViewers).toHaveLength(0)
        await offlineSource.goto('about:blank')

        await previewPeer.getByRole('button', { name: 'Stop following' }).click()
        await expect(followRows).toHaveCount(1)
        await expect(followRows.first()).toContainText('Saved')
        expect(await readStopState(viewer)).toMatchObject({
          followedCount: 1,
          pendingStopCount: 1,
          stoppedViewers: [],
        })
        await viewer.reload()
        await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1', { timeout: 30_000 })
        expect(await readStopState(viewer)).toMatchObject({
          followedCount: 1,
          pendingStopCount: 1,
          stoppedViewers: [],
        })

        await offlineSource.goto('/')
        await expect(offlineSource.locator('.dock-peers')).toContainText('Sharing 1', {
          timeout: 30_000,
        })
        await viewer.reload()
        await expect(viewer.locator('.dock-peers')).toContainText('Seeing 1', { timeout: 30_000 })
        await expect
          .poll(async () => (await readStopState(offlineSource)).stoppedViewers.length, {
            timeout: 30_000,
          })
          .toBe(1)
        const senderState = await readStopState(offlineSource)
        expect(senderState.stoppedViewers[0]?.recordedAt).toBeGreaterThan(0)
        expect(senderState.stoppedViewers[0]?.dismissed).toBe(false)
        expect(await readStopState(viewer)).toMatchObject({
          followedCount: 1,
          pendingStopCount: 0,
          stoppedViewers: [],
        })

        const stoppedPeers = await openPeerList(offlineSource)
        const stoppedHistory = stoppedPeers
          .locator('.peer-list__item')
          .filter({ hasText: 'Stopped following' })
        await expect(stoppedHistory).toHaveCount(1)
        const timestamp = await offlineSource.evaluate(
          (recordedAt) => new Date(recordedAt).toLocaleString(),
          senderState.stoppedViewers[0]!.recordedAt,
        )
        await expect(stoppedHistory).toContainText(timestamp)
        await stoppedHistory.getByRole('button', { name: 'Dismiss' }).click()
        await expect
          .poll(async () => (await readStopState(offlineSource)).stoppedViewers[0]?.dismissed)
          .toBe(true)
        await openPeerFilterMenu(stoppedPeers.page())
        await expect(stoppedPeers.getByLabel('Show ended')).not.toBeChecked()
        await openPeerFilterMenu(stoppedPeers.page())
        await stoppedPeers.getByLabel('Show ended').check()
        await expect(stoppedHistory).toContainText('Stopped following')
        await stoppedPeers.getByRole('button', { name: 'Close' }).click()

        await offlineSource.reload()
        await expect(offlineSource.locator('.dock-peers')).toContainText('Sharing 1', {
          timeout: 30_000,
        })
        const restoredPeers = await openPeerList(offlineSource)
        await openPeerFilterMenu(restoredPeers.page())
        await restoredPeers.getByLabel('Show ended').check()
        const restoredStoppedPeer = restoredPeers
          .locator('.peer-list__item')
          .filter({ hasText: 'Stopped following' })
        await expect(restoredStoppedPeer).toHaveCount(1)
        await expect(restoredStoppedPeer).toContainText(timestamp)
        expect(await readStopState(offlineSource)).toMatchObject({
          stoppedViewers: [
            { recordedAt: senderState.stoppedViewers[0]?.recordedAt, dismissed: true },
          ],
        })

        await openPeerFilter(offlineSource, 'Sharing')
        await expect(offlineSource.getByRole('dialog', { name: 'Active shares' })).toContainText(
          '0 connected',
          { timeout: 30_000 },
        )
        await openPeerFilter(remainingSource, 'Sharing')
        await expect(remainingSource.getByRole('dialog', { name: 'Active shares' })).toContainText(
          '1 connected',
        )
        const remainingFollows = await openPeerFilter(viewer, 'Viewing')
        const remainingFollowRows = remainingFollows.locator('.peer-list__item')
        await expect(remainingFollowRows).toHaveCount(1)
        await expandPeerDetails(remainingFollowRows.first())
        await expect(remainingFollowRows.first()).toContainText('Saved')
      })
    },
    { afterFirstFollow: saveLocationPreview },
  )
})

test('independent links from one source use unlinkable source peer identities', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 48.1372, longitude: 11.5756 })
  await page.goto('/')

  const createLink = async (): Promise<string> => {
    await openShareCreator(page)
    await page.getByRole('button', { name: 'Create location link' }).click()
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
  await expect(page.locator('.dock-peers')).toContainText('Sharing 2', { timeout: 30_000 })
  await openPeerFilter(page, 'Sharing')
  await expandPeerDetails(page.locator('.peer-list__item').first())
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

test('revoking an active share immediately removes its location and records its history', async ({
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
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    await viewer.goto(url)
    await expect(viewer.getByRole('button', { name: 'Keep following' })).toBeVisible({
      timeout: 30_000,
    })
    const request = source.getByRole('region', { name: 'Viewer access request' })
    await expect(request).toBeVisible({ timeout: 30_000 })
    await request.getByRole('button', { name: 'Approve this device' }).click()
    await viewer.getByRole('button', { name: 'Keep following' }).click()
    await viewer.getByRole('button', { name: 'Save location' }).click()
    const shareBack = viewer.getByRole('region', { name: 'Share back invitation' })
    if (await shareBack.isVisible())
      await shareBack.getByRole('button', { name: 'Not now' }).click()

    await openPeerFilter(viewer, 'Viewing')
    await expandPeerDetails(viewer.locator('.peer-list__item').first())
    const following = viewer.getByRole('dialog', { name: 'Following' })
    await expect(following).not.toContainText('Last location: not received', { timeout: 30_000 })
    await following.getByRole('button', { name: 'Close' }).click()

    await openPeerFilter(source, 'Sharing')
    await expandPeerDetails(source.locator('.peer-list__item').first())
    await source.getByRole('button', { name: 'Revoke link' }).click()

    await expect(viewer.locator('.toast')).toContainText(
      'The sender revoked your access to this location.',
      { timeout: 15_000 },
    )
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 0')
    await openPeerFilter(viewer, 'Viewing')
    const history = viewer.locator('.peer-list')
    await openPeerFilterMenu(history.page())
    await expect(history.getByLabel('Show ended')).not.toBeChecked()
    await expect(history.locator('.peer-list__item')).toHaveCount(0)
    await openPeerFilterMenu(history.page())
    await history.getByLabel('Show ended').check()
    await expect(history.locator('.peer-list__item')).toHaveCount(1)
    await expect(history).toContainText('Viewed · revoked')
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
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
    await openShareCreator(source)
    await source.getByRole('button', { name: 'Create location link' }).click()
    const url = await source.getByLabel('Share link').inputValue({ timeout: 30_000 })
    await source.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await viewer.goto(url)
    await viewer.getByRole('button', { name: 'Keep following' }).click({ timeout: 30_000 })
    const request = source.getByRole('region', { name: 'Viewer access request' })
    await expect(request).toBeVisible({ timeout: 30_000 })
    await request.getByRole('button', { name: 'Approve this device' }).click()
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
    await openPeerFilter(source, 'Sharing')
    await expandPeerDetails(source.locator('.peer-list__item').first())
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
    await expect(source.locator('.dock-peers')).toContainText('Sharing 0')
    viewer = await viewerContext.newPage()
    await viewer.goto('/')
    await expect(viewer.locator('.dock-peers')).toContainText('Seeing 0', { timeout: 30_000 })
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
    const history = await openPeerFilter(viewer, 'Viewing')
    await openPeerFilterMenu(history.page())
    await expect(history.getByLabel('Show ended')).not.toBeChecked()
    await openPeerFilterMenu(history.page())
    await history.getByLabel('Show ended').check()
    await expect(history.locator('.peer-list__item')).toHaveCount(1)
    await expect(history).toContainText('Viewed · revoked')
    await expect(
      viewer.getByRole('button', { name: /Share approximate location for 1 hour back to/ }),
    ).toHaveCount(0)
  } finally {
    await viewerContext.close()
    await sourceContext.close()
  }
})

test('admission adopts the advertised name and share-back presence belongs to the same peer', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { probeInitialNamesAndReturnPresence } = await import('../tests/fixtures/share-probe.ts')
    return probeInitialNamesAndReturnPresence()
  })
  expect(result).toEqual({
    pendingAliasReplaced: true,
    initialName: 'River',
    recipientBound: true,
    returnViewerCount: 1,
    reciprocalPeer: true,
  })
})

test('a late initial advertisement replaces a saved alias and accepted names survive reload', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { probeLateInitialName } = await import('../tests/fixtures/share-probe.ts')
    return probeLateInitialName()
  })
  expect(result).toEqual({
    provisionalStaysProvisional: true,
    initialName: 'Late name',
    updateStaysPending: true,
    restoredName: 'Late name',
  })
})

for (const mode of ['first-device', 'multi-viewer'] as const) {
  test(`closes the QR screen on ${mode} admission and allows reopening it`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000)
    if (!baseURL) throw new Error('A base URL is required.')
    const sourceContext = await browser.newContext({
      baseURL,
      geolocation: { latitude: 48.1372, longitude: 11.5756 },
      permissions: ['geolocation'],
    })
    const viewerContext = await browser.newContext({ baseURL })
    try {
      const source = await sourceContext.newPage()
      await source.goto('/')
      await openShareCreator(source)
      if (mode === 'first-device')
        await source.getByLabel(/Approve the recipient device before sharing/).uncheck()
      else await source.getByRole('button', { name: '10', exact: true }).click()
      await source.getByRole('button', { name: 'Create location link' }).click()
      const shareReady = source.getByRole('dialog', { name: 'Share this QR code' })
      const url = await shareReady.getByLabel('Share link').inputValue({ timeout: 30_000 })
      await expect(shareReady).toBeVisible()
      const viewer = await viewerContext.newPage()
      await viewer.goto(url)
      await expect(shareReady).toHaveCount(0, { timeout: 30_000 })
      await expect(source.getByRole('region', { name: 'Viewer access request' })).toHaveCount(0)
      const peers = await openPeerFilter(source, 'Sharing')
      await expandPeerDetails(source.locator('.peer-list__item').first())
      await expect(peers).toContainText('Connected viewers (1)')
      await peers.getByRole('button', { name: 'Show link / QR' }).click()
      await expect(shareReady).toBeVisible()
      await expect(shareReady.getByLabel('Share link')).toHaveValue(url)
      // Routine presence updates must not immediately dismiss a deliberately reopened QR.
      await expect(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        await expect(shareReady).toBeVisible()
      }).toPass({ timeout: 5_000 })
    } finally {
      await viewerContext.close()
      await sourceContext.close()
    }
  })
}
