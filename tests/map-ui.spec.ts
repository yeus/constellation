import { expect, test } from '@playwright/test'
import type * as Vue from 'vue'
import type { MapLocation } from '../src/location/mapModel.ts'
import { withTwoSources } from './fixtures/two-sources.ts'
import { openPeerList, openShareCreator, saveLocationPreview } from './fixtures/peer-navigation.ts'

test('uses local browser fonts for labeled map layers', async ({ page }) => {
  await page.goto('/')
  const style = await page.evaluate(async () => {
    const { createWorldStyle, DEFAULT_WORLD_PMTILES_URL } = await import('../src/map/pmtiles.ts')
    return createWorldStyle(DEFAULT_WORLD_PMTILES_URL, 'default', 'light')
  })

  expect(style.glyphs).toBeUndefined()
  expect(style.layers.some((layer) => layer.type === 'symbol')).toBe(true)
})

test('keeps map zoom controls outside the compact peer navigation dock', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')

  const navigation = page.locator('.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group')
  const overlays = [page.locator('.dock-peers'), page.locator('.connection-dock')]
  await expect(navigation).toBeVisible()
  const [navigationBox, ...overlayBoxes] = await Promise.all([
    navigation.boundingBox(),
    ...overlays.map((overlay) => overlay.boundingBox()),
  ])

  if (!navigationBox || overlayBoxes.some((box) => !box)) {
    throw new Error('Expected map controls and share button to be laid out.')
  }
  overlayBoxes.forEach((box) => {
    if (!box) return
    const overlaps =
      navigationBox.x < box.x + box.width &&
      navigationBox.x + navigationBox.width > box.x &&
      navigationBox.y < box.y + box.height &&
      navigationBox.y + navigationBox.height > box.y
    expect(overlaps).toBe(false)
  })
})

test('preserves the map viewport when the compact peer list opens and closes', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')
  const canvas = page.locator('.maplibregl-canvas')
  const surface = page.locator('.map-surface')
  await expect(canvas).toBeVisible()
  const initial = await surface.boundingBox()
  await page.locator('.dock-peers').click()
  const peers = page.getByRole('dialog', { name: 'Peers' })
  await expect(peers).toBeVisible()
  await peers.getByRole('button', { name: 'Close' }).click()
  await expect
    .poll(async () => {
      const bounds = await surface.boundingBox()
      return bounds?.height ?? 0
    })
    .toBe(initial?.height ?? 0)
  await expect
    .poll(async () => {
      const bounds = await canvas.boundingBox()
      return Math.round(bounds?.height ?? 0)
    })
    .toBe(Math.round((await surface.boundingBox())?.height ?? 0))
})

test('keeps map attribution clear of the peer dock at the lower-right', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/')

  const attribution = page.locator('.maplibregl-ctrl-attrib')
  await expect(attribution).toBeVisible()
  const bounds = await attribution.boundingBox()
  const mapBounds = await page.locator('.map-surface').boundingBox()
  const viewport = page.viewportSize()
  if (!bounds || !viewport || !mapBounds) throw new Error('Expected map attribution and surface.')

  expect(viewport.width - bounds.x - bounds.width).toBeLessThanOrEqual(24)

  const shareBounds = await page.locator('.dock-peers').boundingBox()
  if (!shareBounds) throw new Error('Expected the sharing button to be laid out.')
  const overlapsShare =
    bounds.x < shareBounds.x + shareBounds.width &&
    bounds.x + bounds.width > shareBounds.x &&
    bounds.y < shareBounds.y + shareBounds.height &&
    bounds.y + bounds.height > shareBounds.y
  expect(overlapsShare).toBe(false)
  await expect(page.locator('.dock-peers')).toBeVisible()
  const foldedBounds = await attribution.boundingBox()
  if (!foldedBounds) throw new Error('Expected attribution after folding sharing actions.')
  expect(mapBounds.y + mapBounds.height - foldedBounds.y - foldedBounds.height).toBeLessThanOrEqual(
    24,
  )
  await expect(attribution).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const fontSize = Number.parseFloat(
    await attribution.evaluate((element) => getComputedStyle(element).fontSize),
  )
  expect(fontSize).toBeGreaterThanOrEqual(10)
  expect(fontSize).toBeLessThanOrEqual(11)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(attribution.getByRole('link', { name: '© OpenStreetMap contributors' })).toHaveCSS(
    'color',
    'rgb(243, 245, 248)',
  )
})

test('keeps the wordmark high at the right above the menu and recenter row', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')
  const title = await page.getByText('Constellation', { exact: true }).boundingBox()
  const menu = await page.getByRole('button', { name: 'Open menu' }).boundingBox()
  const recenter = await page.getByRole('button', { name: 'Center on my location' }).boundingBox()
  if (!title || !menu || !recenter) throw new Error('Expected the complete top row.')
  expect(title.x + title.width).toBeGreaterThan(400)
  expect(title.y + title.height).toBeLessThanOrEqual(menu.y)
  expect(Math.abs(menu.y - recenter.y)).toBeLessThan(2)
})

test('frames the first acquired accuracy area without following later updates', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      deliverPosition?: PositionCallback
      cameraCalls?: Array<{ bounds: [[number, number], [number, number]] }>
    }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback) {
          testWindow.deliverPosition = success
          return 1
        },
        clearWatch() {},
      },
    })
  })
  await page.goto('/')
  await page.waitForFunction(() => 'deliverPosition' in window)
  await page.getByRole('button', { name: 'Center on my location' }).click()
  await expect(page.getByRole('status').last()).toContainText('Waiting for your location')

  await page.evaluate(async () => {
    const testWindow = window as typeof window & {
      deliverPosition: PositionCallback
      cameraCalls: Array<{ bounds: [[number, number], [number, number]] }>
    }
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/maplibre-gl.js'))?.name
    if (!moduleUrl) throw new Error('MapLibre module was not loaded.')
    const maplibre = await import(/* @vite-ignore */ moduleUrl)
    const originalFitBounds = maplibre.Map.prototype.fitBounds
    testWindow.cameraCalls = []
    maplibre.Map.prototype.fitBounds = function (bounds: [[number, number], [number, number]]) {
      testWindow.cameraCalls.push({ bounds })
      return originalFitBounds.call(this, bounds)
    }
    testWindow.deliverPosition({
      timestamp: Date.now(),
      coords: {
        latitude: 41.5,
        longitude: 12.5,
        accuracy: 20,
        altitude: null,
        heading: null,
        speed: null,
      },
    } as GeolocationPosition)
  })

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { cameraCalls: unknown[] }).cameraCalls.length,
      ),
    )
    .toBe(1)
  await expect(page.getByRole('status').last()).not.toContainText('Waiting for your location')
  const first = await page.evaluate(
    () =>
      (
        window as typeof window & {
          cameraCalls: Array<{ bounds: [[number, number], [number, number]] }>
        }
      ).cameraCalls[0],
  )
  if (!first) throw new Error('Expected an initial camera move.')
  expect(first.bounds[0][0]).toBeLessThan(12.5)
  expect(first.bounds[0][1]).toBeLessThan(41.5)
  expect(first.bounds[1][0]).toBeGreaterThan(12.5)
  expect(first.bounds[1][1]).toBeGreaterThan(41.5)

  await page.evaluate(() => {
    ;(window as typeof window & { deliverPosition: PositionCallback }).deliverPosition({
      timestamp: Date.now(),
      coords: {
        latitude: 42,
        longitude: 13,
        accuracy: 20,
        altitude: null,
        heading: null,
        speed: null,
      },
    } as GeolocationPosition)
  })
  await expect(page.getByRole('button', { name: 'Center on my location' })).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as typeof window & { cameraCalls: unknown[] }).cameraCalls.length,
    ),
  ).toBe(1)
})

test('shows a useful message when the desktop browser cannot initialize WebGL', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => {
    const canvasPrototype = HTMLCanvasElement.prototype as unknown as {
      getContext: (contextId: string, ...args: unknown[]) => unknown
    }
    const originalGetContext = canvasPrototype.getContext
    canvasPrototype.getContext = function (contextId, ...args) {
      if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
        return null
      }
      return originalGetContext.call(this, contextId, ...args)
    }
  })

  await page.goto('/')

  const error = page.getByRole('alert')
  await expect(error).toContainText(
    'WebGL unavailable: this browser could not create a rendering context.',
  )
  await expect(error).toHaveCSS('color', 'rgb(132, 36, 46)')
})

test('persists independent local map grouping controls', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  const settings = page.locator('.map-decluttering-settings')
  await settings.locator('summary').click()
  const markerGrouping = settings.getByLabel('Group colliding markers')
  const areaGrouping = settings.getByLabel('Group overlapping areas')
  await expect(markerGrouping).toBeChecked()
  await expect(areaGrouping).toBeChecked()
  await markerGrouping.uncheck()
  await settings
    .locator('input[type="range"]')
    .first()
    .evaluate((input) => {
      const slider = input as HTMLInputElement
      slider.value = '0.75'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
  await expect(settings).toContainText('Area overlap: 75%')

  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('constellation.map-decluttering') ?? '{}'),
      ),
    )
    .toMatchObject({ groupMarkerCollisions: false, groupUncertaintyOverlap: true })
  await page.reload()
  await page.getByRole('button', { name: 'Open menu' }).click()
  const restoredSettings = page.locator('.map-decluttering-settings')
  await restoredSettings.locator('summary').click()
  await expect(restoredSettings.getByLabel('Group colliding markers')).not.toBeChecked()
  await expect(restoredSettings.getByLabel('Group overlapping areas')).toBeChecked()
  await expect(restoredSettings).toContainText('Area overlap: 75%')
})

test('explains when the PMTiles archive cannot be downloaded', async ({ page }) => {
  await page.route('**/*.pmtiles*', (route) => route.abort())
  await page.goto('/')

  await expect(page.getByRole('alert')).toContainText(
    /(Basemap|Map) error \(network\): (Failed to fetch|Load failed)/,
  )
})

test('uses the shared Taskyon light and dark theme neutrals', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const readThemeColors = () => {
    const styles = getComputedStyle(document.documentElement)
    return {
      background: styles.getPropertyValue('--page-background').trim(),
      text: styles.getPropertyValue('--text').trim(),
      map: styles.getPropertyValue('--map-background').trim(),
    }
  }

  await expect
    .poll(() => page.evaluate(readThemeColors))
    .toEqual({
      background: '#f5f6f8',
      text: '#202632',
      map: '#edf1f4',
    })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(() => page.evaluate(readThemeColors))
    .toEqual({
      background: '#0d1117',
      text: '#f3f5f8',
      map: '#0e1116',
    })
})

test('centers the close icon inside sheet close buttons', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Privacy and licenses' }).click()

  const button = page.getByRole('dialog', { name: 'Constellation' }).getByRole('button', {
    name: 'Close',
  })
  const icon = button.locator('svg')
  await expect(button).toBeVisible()
  const [buttonBox, iconBox] = await Promise.all([button.boundingBox(), icon.boundingBox()])
  if (!buttonBox || !iconBox) throw new Error('Expected the close button and icon to be laid out.')
  const centerDelta = {
    x: Math.abs(buttonBox.x + buttonBox.width / 2 - (iconBox.x + iconBox.width / 2)),
    y: Math.abs(buttonBox.y + buttonBox.height / 2 - (iconBox.y + iconBox.height / 2)),
  }
  expect(centerDelta.x).toBeLessThanOrEqual(0.5)
  expect(centerDelta.y).toBeLessThanOrEqual(0.5)
})

test('uses centered SVG icons for icon buttons', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Privacy and licenses' }).click()
  const buttons = page.locator('.top-bar button, .dock-add, .icon-button')
  const count = await buttons.count()
  expect(count).toBeGreaterThanOrEqual(2)
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index)
    await expect(button.locator('svg')).toHaveCount(1)
    const [buttonBox, iconBox] = await Promise.all([
      button.boundingBox(),
      button.locator('svg').boundingBox(),
    ])
    if (!buttonBox || !iconBox) throw new Error('Expected each icon button to be laid out.')
    expect(
      Math.abs(buttonBox.x + buttonBox.width / 2 - (iconBox.x + iconBox.width / 2)),
    ).toBeLessThanOrEqual(0.5)
    expect(
      Math.abs(buttonBox.y + buttonBox.height / 2 - (iconBox.y + iconBox.height / 2)),
    ).toBeLessThanOrEqual(0.5)
  }
})

test('keeps status notes near the screen edge and hides them after six seconds', async ({
  page,
}) => {
  await page.goto('/#share=invalid')
  const notice = page.locator('.toast')
  await expect(notice).toBeVisible()
  const bounds = await notice.boundingBox()
  const viewport = page.viewportSize()
  if (!bounds || !viewport) throw new Error('Expected the status note to be laid out.')
  expect(bounds.y + bounds.height / 2).toBeLessThan(viewport.height / 3)
  expect(bounds.x + bounds.width / 2).toBeGreaterThan(viewport.width / 2)
  await expect(notice).toBeHidden({ timeout: 8_000 })
})

test('keeps map credit visible and persists the selected basemap family', async ({ page }) => {
  await page.route('**/*.pmtiles*', (route) => route.abort())
  await page.goto('/')

  await expect(page.getByText('© OpenStreetMap contributors')).toBeVisible()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('button', { name: 'Minimalist map' }).click()
  await expect(page.getByRole('region', { name: 'App menu' })).toBeHidden()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('button', { name: 'Minimalist map' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.reload()
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('button', { name: 'Minimalist map' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByText('© OpenStreetMap contributors')).toBeVisible()
})

test('shows oversized uncertainty avatars and reports every overflow peer', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000)
  if (!baseURL) throw new Error('The area workflow requires the local relay.')
  await page.setViewportSize({ width: 320, height: 640 })
  await page.route('**/*.pmtiles*', (route) => route.abort())
  await page.goto('/')

  await page.evaluate(async () => {
    const vueModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    const maplibreModuleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/maplibre-gl.js'))?.name
    if (!vueModuleUrl || !maplibreModuleUrl)
      throw new Error('The map browser modules were not loaded.')
    const { createApp, h } = await import(/* @vite-ignore */ vueModuleUrl)
    const maplibre = await import(/* @vite-ignore */ maplibreModuleUrl)
    const { default: LocationMap } = await import('../src/components/LocationMap.vue')
    const { locationAreaBounds } = await import('../src/location/mapModel.ts')
    const labels = ['Ada North', 'Ben South', 'Cora East', 'Drew West', 'Eli Center', 'Faye Coast']
    const locations = labels.map((label, index) => ({
      id: `synthetic-peer-${index}`,
      latitude: 20,
      longitude: 0,
      precision: 'approximate' as const,
      radiusMeters: 8_000_000,
      label,
    }))
    const container = document.createElement('div')
    container.id = 'area-stack-test'
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: '320px',
      height: '360px',
      zIndex: '9999',
    })
    document.body.append(container)
    const cameraBounds: unknown[] = []
    const originalFitBounds = maplibre.Map.prototype.fitBounds
    maplibre.Map.prototype.fitBounds = function (bounds: unknown) {
      cameraBounds.push(bounds)
      return originalFitBounds.call(this, bounds)
    }
    const overflowIds: string[][] = []
    const app = createApp({
      render: () =>
        h(LocationMap, {
          locations,
          decluttering: {
            enabled: true,
            groupMarkerCollisions: true,
            groupUncertaintyOverlap: true,
            uncertaintyOverlapThreshold: 0.45,
            markerCollisionDistancePx: 48,
          },
          onAreaOverflow: (ids: string[]) => overflowIds.push(ids),
        }),
    })
    app.mount(container)
    const testWindow = window as typeof window & {
      areaStackTest?: {
        app: { unmount: () => void }
        container: HTMLElement
        cameraBounds: unknown[]
        expectedBounds: unknown
        overflowIds: string[][]
        restoreFitBounds: () => void
      }
    }
    testWindow.areaStackTest = {
      app,
      container,
      cameraBounds,
      expectedBounds: locationAreaBounds(locations[0]!),
      overflowIds,
      restoreFitBounds: () => {
        maplibre.Map.prototype.fitBounds = originalFitBounds
      },
    }
  })

  const mapRoot = page.locator('#area-stack-test')
  const stack = mapRoot.locator('.location-map__large-peers')
  await expect(stack).toBeVisible({ timeout: 30_000 })
  await expect(stack).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(stack).toHaveCSS('border-width', '0px')
  await expect(stack.locator('h1, h2, h3, h4, p')).toHaveCount(0)
  await expect(stack.getByRole('button')).toHaveCount(4)
  expect(await stack.locator('.peer-avatar').allTextContents()).toEqual(['AN', 'BS', 'CE'])

  const stackBounds = await stack.boundingBox()
  const mapBounds = await mapRoot.boundingBox()
  if (!stackBounds || !mapBounds) throw new Error('Expected the avatar stack to fit the map area.')
  expect(stackBounds.x).toBeGreaterThanOrEqual(mapBounds.x)
  expect(stackBounds.x + stackBounds.width).toBeLessThanOrEqual(mapBounds.x + mapBounds.width)
  expect(stackBounds.y + stackBounds.height).toBeLessThanOrEqual(mapBounds.y + mapBounds.height)
  expect(stackBounds.x - mapBounds.x).toBeLessThanOrEqual(16)
  expect(mapBounds.y + mapBounds.height - stackBounds.y - stackBounds.height).toBeLessThanOrEqual(
    24,
  )
  for (const control of [
    mapRoot.locator('.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group'),
    mapRoot.locator('.maplibregl-ctrl-attrib'),
  ]) {
    const controlBounds = await control.boundingBox()
    if (!controlBounds) throw new Error('Expected map controls and attribution to be laid out.')
    const overlaps =
      stackBounds.x < controlBounds.x + controlBounds.width &&
      stackBounds.x + stackBounds.width > controlBounds.x &&
      stackBounds.y < controlBounds.y + controlBounds.height &&
      stackBounds.y + stackBounds.height > controlBounds.y
    expect(overlaps).toBe(false)
  }

  await stack.getByRole('button', { name: 'Show all peers in this area' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              areaStackTest: { overflowIds: string[][] }
            }
          ).areaStackTest.overflowIds,
      ),
    )
    .toEqual([
      [
        'synthetic-peer-0',
        'synthetic-peer-1',
        'synthetic-peer-2',
        'synthetic-peer-3',
        'synthetic-peer-4',
        'synthetic-peer-5',
      ],
    ])

  await stack.getByRole('button', { name: 'Show Ada North area on map' }).click()
  const cameraBounds = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      areaStackTest: { cameraBounds: unknown[]; expectedBounds: unknown }
    }
    return {
      actual: testWindow.areaStackTest.cameraBounds,
      expected: testWindow.areaStackTest.expectedBounds,
    }
  })
  expect(cameraBounds.actual).toEqual([cameraBounds.expected])

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      areaStackTest?: {
        app: { unmount: () => void }
        container: HTMLElement
        restoreFitBounds: () => void
      }
    }
    const fixture = testWindow.areaStackTest
    if (!fixture) return
    fixture.app.unmount()
    fixture.restoreFitBounds()
    fixture.container.remove()
    delete testWindow.areaStackTest
  })

  // Component geometry runs in both projects; real transport integration runs once.
  if (testInfo.project.name !== 'desktop') return
  await withTwoSources(
    browser,
    baseURL,
    { viewport: { width: 320, height: 640 } },
    async ({ viewer }) => {
      await saveLocationPreview(viewer)
      await openShareCreator(viewer)
      await viewer.getByRole('button', { name: 'Create location link' }).click()
      await expect(viewer.getByLabel('Share link')).toBeVisible({ timeout: 30_000 })
      await viewer.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      const allPeers = await openPeerList(viewer)
      await expect(allPeers.locator('details.peer-list__item')).toHaveCount(3)
      await allPeers.getByRole('button', { name: 'Close' }).click()
      const introduction = viewer.getByRole('region', { name: 'Privacy introduction' })
      if (await introduction.isVisible())
        await introduction.getByRole('button', { name: 'Got it' }).click()
      // Control the actual map surface geometry to exercise overflow with two real peers.
      // The screen's minimum height otherwise keeps enough stack slots for both.
      await viewer.locator('.map-surface').evaluate((surface) => {
        const element = surface as HTMLElement
        element.style.height = '250px'
        element.style.bottom = 'auto'
      })
      const overflow = viewer.getByRole('button', { name: 'Show all peers in this area' })
      await expect(overflow).toBeVisible({ timeout: 30_000 })
      await overflow.click()
      const areaPeers = viewer.locator('.peer-list')
      await expect(areaPeers.locator('details.peer-list__item')).toHaveCount(2)
      await expect(areaPeers.locator('.peer-list__summary-name')).toHaveText(['Forest', 'River'])
      await areaPeers.getByRole('button', { name: 'Close' }).click()
      const restored = await openPeerList(viewer)
      await expect(restored.locator('details.peer-list__item')).toHaveCount(3)
      await restored.locator('.peer-list__filter-menu > summary').click()
      await expect(restored.getByRole('button', { name: 'All', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    },
    { afterFirstFollow: saveLocationPreview, sourceAccuracyMeters: 8_000_000 },
  )
})

test('fills the bottom dock and uses smaller translucent navigation in both themes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto('/')
  const dock = page.locator('.connection-dock')
  const button = page.locator('.dock-peers')
  await expect(button).toBeVisible()
  const dockBox = await dock.boundingBox()
  const buttonBox = await button.boundingBox()
  if (!dockBox || !buttonBox) throw new Error('Expected dock layout')
  expect(buttonBox.width).toBeCloseTo(dockBox.width - 24, 0)
  expect(buttonBox.x + buttonBox.width / 2).toBeCloseTo(dockBox.x + dockBox.width / 2, 0)
  const navigation = page.locator('.maplibregl-ctrl-group')
  const zoom = navigation.locator('button').first()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(zoom).toHaveCSS('width', '44px')
    await expect(zoom).toHaveCSS('height', '44px')
    await expect(navigation).toHaveCSS(
      'background-color',
      colorScheme === 'dark' ? 'rgba(22, 29, 39, 0.65)' : 'rgba(255, 255, 255, 0.72)',
    )
    await expect(zoom.locator('.maplibregl-ctrl-icon')).toHaveCSS(
      'filter',
      colorScheme === 'dark' ? 'invert(1)' : 'none',
    )
  }
})

test('indicates an oversized own area and restores it through recentering', async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success: PositionCallback) {
          ;(window as typeof window & { deliverPosition: PositionCallback }).deliverPosition =
            success
          return 1
        },
        clearWatch() {},
      },
    })
  })
  const mapModule = page.waitForResponse((response) =>
    response.url().includes('/node_modules/.vite/deps/maplibre-gl.js'),
  )
  await page.goto('/')
  await page.waitForFunction(() => 'deliverPosition' in window)
  await page.evaluate(
    async (url) => {
      const { Map } = await import(/* @vite-ignore */ url)
      const original = Map.prototype.project
      Map.prototype.project = function (...args: unknown[]) {
        ;(window as typeof window & { ownAreaMap: unknown }).ownAreaMap = this
        return original.apply(this, args)
      }
      ;(window as typeof window & { deliverPosition: PositionCallback }).deliverPosition({
        timestamp: Date.now(),
        coords: {
          latitude: 20,
          longitude: 0,
          accuracy: 10000,
          altitude: null,
          heading: null,
          speed: null,
        },
      } as GeolocationPosition)
    },
    (await mapModule).url(),
  )
  const recenter = page.locator('.recenter-button')
  await expect(recenter).toHaveClass(/recenter-button--live/)
  await page.waitForFunction(() => 'ownAreaMap' in window)
  await page.evaluate(() => {
    const map = (
      window as typeof window & { ownAreaMap: { stop(): void; setZoom(zoom: number): void } }
    ).ownAreaMap
    map.stop()
    map.setZoom(17)
  })
  await expect(page.locator('.recenter-button__area-badge')).toBeVisible()
  await expect(recenter).toHaveAttribute('aria-label', /area is hidden at this zoom/)
  await recenter.click()
  await expect(page.locator('.recenter-button__area-badge')).toHaveCount(0)
  await expect(recenter).toHaveAttribute('aria-label', /Live location/)
  await page.clock.fastForward(15_001)
  await expect(recenter).toHaveClass(/recenter-button--muted/)
  await expect(recenter).toHaveAttribute('aria-label', /Delayed location/)
  await page.clock.fastForward(45_001)
  await expect(recenter).toHaveClass(/recenter-button--muted/)
  await expect(recenter).toHaveAttribute('aria-label', /Last known location/)
})

test('selects self and peers independently in a group and paints only own point dots', async ({
  page,
}) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const resources = performance.getEntriesByType('resource')
    const vueUrl = resources.find((entry) =>
      entry.name.includes('/node_modules/.vite/deps/vue.js'),
    )?.name
    const mapUrl = resources.find((entry) =>
      entry.name.includes('/node_modules/.vite/deps/maplibre-gl.js'),
    )?.name
    if (!vueUrl || !mapUrl) throw new Error('Browser map modules missing')
    const { createApp, h, ref } = (await import(/* @vite-ignore */ vueUrl)) as typeof Vue
    const { Map } = await import(/* @vite-ignore */ mapUrl)
    const { default: LocationMap } = await import('../src/components/LocationMap.vue')
    const locations = ref<MapLocation[]>([
      {
        id: 'synthetic-self',
        isOwn: true,
        latitude: 20,
        longitude: 0,
        precision: 'exact',
        color: '#f78f3b',
      },
      { id: 'synthetic-peer', latitude: 20, longitude: 0, precision: 'exact', label: 'River' },
    ])
    const container = document.createElement('div')
    container.id = 'self-group-test'
    Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '9999' })
    document.body.append(container)
    const selections: string[] = []
    const original = Map.prototype.project
    let pointFilter = (): unknown => undefined
    Map.prototype.project = function (...args: unknown[]) {
      if (this.getContainer().closest('#self-group-test'))
        pointFilter = () => this.getFilter('constellation-locations-points')
      return original.apply(this, args)
    }
    const app = createApp({
      render: () =>
        h(LocationMap, {
          locations: locations.value,
          decluttering: {
            enabled: true,
            groupMarkerCollisions: true,
            groupUncertaintyOverlap: true,
            uncertaintyOverlapThreshold: 0.9,
            markerCollisionDistancePx: 18,
          },
          onCenterOwn: () => selections.push('self'),
          onSelect: (id: string) => selections.push(id),
        }),
    })
    app.mount(container)
    ;(window as typeof window & { selfGroupTest: unknown }).selfGroupTest = {
      selections,
      separate: () => {
        locations.value = locations.value.map((location) =>
          location.isOwn ? location : { ...location, longitude: 30 },
        )
      },
      pointFilter: () => pointFilter(),
      dispose: () => {
        app.unmount()
        container.remove()
        Map.prototype.project = original
      },
    }
  })
  const root = page.locator('#self-group-test')
  const self = root.getByRole('button', { name: 'Center on my location' })
  await expect(self).toBeVisible()
  await expect(self).toHaveText('ME')
  await expect(self.locator('.peer-avatar')).toHaveCSS('color', 'rgb(247, 143, 59)')
  await self.click()
  await root.getByRole('button', { name: 'Show River details' }).click()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { selfGroupTest: { selections: string[] } }).selfGroupTest
          .selections,
    ),
  ).toEqual(['self', 'synthetic-peer'])
  expect(
    await page.evaluate(() =>
      (
        window as typeof window & { selfGroupTest: { pointFilter(): unknown } }
      ).selfGroupTest.pointFilter(),
    ),
  ).toEqual(['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'isOwn'], true]])
  await page.evaluate(() =>
    (window as typeof window & { selfGroupTest: { separate(): void } }).selfGroupTest.separate(),
  )
  await expect(root.locator('.location-map__group')).toHaveCount(0)
  await expect(root.locator('.location-map__single-avatar')).toHaveCount(1)
  await page.evaluate(() =>
    (window as typeof window & { selfGroupTest: { dispose(): void } }).selfGroupTest.dispose(),
  )
})
