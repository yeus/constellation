import { expect, test } from '@playwright/test'

test('uses local browser fonts for labeled map layers', async ({ page }) => {
  await page.goto('/')
  const style = await page.evaluate(async () => {
    const { createWorldStyle, DEFAULT_WORLD_PMTILES_URL } = await import('../src/map/pmtiles.ts')
    return createWorldStyle(DEFAULT_WORLD_PMTILES_URL, 'default', 'light')
  })

  expect(style.glyphs).toBeUndefined()
  expect(style.layers.some((layer) => layer.type === 'symbol')).toBe(true)
})

test('keeps map zoom controls outside the share button hit area', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')

  const navigation = page.locator('.maplibregl-ctrl-bottom-right > .maplibregl-ctrl-group')
  const overlays = [
    page.getByRole('button', { name: 'Share location' }),
    page.locator('.connection-dock'),
  ]
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

test('resizes the map canvas when sharing actions fold', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')
  const canvas = page.locator('.maplibregl-canvas')
  const surface = page.locator('.map-surface')
  await expect(canvas).toBeVisible()
  const initial = await surface.boundingBox()
  await page.getByRole('button', { name: 'Show sharing actions' }).click()
  await expect
    .poll(async () => {
      const bounds = await surface.boundingBox()
      return bounds?.height ?? 0
    })
    .toBeGreaterThan(initial?.height ?? 0)
  await expect
    .poll(async () => {
      const bounds = await canvas.boundingBox()
      return Math.round(bounds?.height ?? 0)
    })
    .toBe(Math.round((await surface.boundingBox())?.height ?? 0))
})

test('keeps map attribution clear of sharing actions and at the lower-right when folded', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/')

  const attribution = page.locator('.maplibregl-ctrl-attrib')
  await expect(attribution).toBeVisible()
  const bounds = await attribution.boundingBox()
  const mapBounds = await page.locator('.map-surface').boundingBox()
  const viewport = page.viewportSize()
  if (!bounds || !viewport || !mapBounds) throw new Error('Expected map attribution and surface.')

  expect(viewport.width - bounds.x - bounds.width).toBeLessThanOrEqual(24)

  const shareBounds = await page.getByRole('button', { name: 'Share location' }).boundingBox()
  if (!shareBounds) throw new Error('Expected the sharing button to be laid out.')
  const overlapsShare =
    bounds.x < shareBounds.x + shareBounds.width &&
    bounds.x + bounds.width > shareBounds.x &&
    bounds.y < shareBounds.y + shareBounds.height &&
    bounds.y + bounds.height > shareBounds.y
  expect(overlapsShare).toBe(false)
  await page.getByRole('button', { name: 'Show sharing actions' }).click()
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

test('keeps the title high in the top-right corner above connection status', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')

  const title = await page.getByText('Constellation', { exact: true }).boundingBox()
  const connection = await page.locator('.connection-state').boundingBox()
  if (!title || !connection) throw new Error('Expected title and connection status.')
  expect(title.x + title.width).toBeGreaterThan(400)
  expect(title.y + title.height).toBeLessThanOrEqual(connection.y)
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
    const maplibre = (await import(/* @vite-ignore */ moduleUrl)).default
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
