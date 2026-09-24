import { expect, test } from '@playwright/test'

test('keeps map zoom controls outside the share button hit area', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 860 })
  await page.goto('/')

  const navigation = page.locator('.maplibregl-ctrl-bottom-right')
  const overlays = [
    page.getByRole('button', { name: 'Share location' }),
    page.locator('.status-card'),
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

test('shows a useful message when the desktop browser cannot initialize WebGL', async ({
  page,
}) => {
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

  await expect(page.getByRole('status')).toContainText('Map rendering unavailable')
})

test('explains when the PMTiles archive cannot be downloaded', async ({ page }) => {
  await page.route('**/*.pmtiles*', (route) => route.abort())
  await page.goto('/')

  await expect(page.getByRole('status')).toContainText('Basemap data could not be loaded')
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
