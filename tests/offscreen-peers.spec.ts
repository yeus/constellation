import { expect, test } from '@playwright/test'

test('unified peer rail prioritizes uncertainty-aware proximity and fits between menu and footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await page.route('**/*.pmtiles*', (route) => route.abort())
  await page.goto('/')
  await page.evaluate(async () => {
    const vueUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueUrl) throw new Error('Vue module unavailable in the browser fixture.')
    const { createApp, h } = await import(/* @vite-ignore */ vueUrl)
    const { default: LocationMap } = await import('../src/components/LocationMap.vue')
    const entries = [
      { id: 'on-screen-area', label: 'On screen area', longitude: 0, radiusMeters: 8_000_000 },
      { id: 'uncertain', label: 'Large uncertainty', longitude: 8, radiusMeters: 600_000 },
      { id: 'close', label: 'Close Exact', longitude: 9, accuracyMeters: 5 },
      { id: 'far', label: 'Far Exact', longitude: 10, accuracyMeters: 5 },
      { id: 'eleven', label: 'Eleven', longitude: 11, accuracyMeters: 5 },
      { id: 'twelve', label: 'Twelve', longitude: 12, accuracyMeters: 5 },
      { id: 'thirteen', label: 'Thirteen', longitude: 13, accuracyMeters: 5 },
      { id: 'fourteen', label: 'Fourteen', longitude: 14, accuracyMeters: 5 },
    ]
    const locations = entries.map(({ id, label, longitude, ...uncertainty }) => ({
      id,
      label,
      longitude,
      latitude: 0,
      precision: 'radiusMeters' in uncertainty ? 'approximate' : 'exact',
      ...uncertainty,
    }))
    const container = document.createElement('div')
    container.id = 'offscreen-rail-test'
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: '320px',
      height: '360px',
      zIndex: '9999',
    })
    document.body.append(container)
    const selections: string[] = []
    const camera: { longitude: number; latitude: number; zoom: number }[] = []
    const app = createApp({
      render: () =>
        h(LocationMap, {
          locations,
          initialCamera: { latitude: 0, longitude: 0, zoom: 4 },
          decluttering: {
            enabled: false,
            groupMarkerCollisions: false,
            groupUncertaintyOverlap: false,
            uncertaintyOverlapThreshold: 0.45,
            markerCollisionDistancePx: 48,
          },
          onSelect: (id: string) => selections.push(id),
          onCameraChange: (position: { longitude: number; latitude: number; zoom: number }) =>
            camera.push(position),
        }),
    })
    app.mount(container)
    Object.assign(window, { offscreenRailTest: { app, container, selections, camera } })
  })

  const fixture = page.locator('#offscreen-rail-test')
  const rail = fixture.getByRole('complementary', {
    name: 'Peers outside or larger than the visible map',
  })
  await expect(rail).toBeVisible({ timeout: 30_000 })
  await expect(rail.getByRole('button')).toHaveCount(5)
  await expect(rail.getByRole('button').nth(0)).toHaveAttribute(
    'aria-label',
    'Center map on Close Exact',
  )
  await expect(rail.getByRole('button').nth(1)).toHaveAttribute(
    'aria-label',
    'Center map on Far Exact',
  )
  await expect(rail.getByRole('button').last()).toHaveAttribute(
    'aria-label',
    'Center map on Thirteen',
  )
  await expect(fixture.locator('.location-map__large-peers')).toHaveCount(0)
  await expect(rail.getByRole('button', { name: /^Show all / })).toHaveCount(0)
  const bounds = await rail.boundingBox()
  const map = await fixture.boundingBox()
  if (!bounds || !map) throw new Error('Missing off-screen rail or map bounds.')
  expect(bounds.y).toBeGreaterThanOrEqual(map.y + 95)
  expect(bounds.x).toBeGreaterThanOrEqual(map.x)
  expect(bounds.x - map.x).toBeLessThan(16)
  expect(map.y + map.height - bounds.y - bounds.height).toBeCloseTo(20, 0)
  // More height makes the oversized area available in the same rail, not a second stack.
  await fixture.evaluate((element) => {
    element.style.height = '640px'
  })
  await expect(rail.getByRole('button')).toHaveCount(8)
  await rail.getByRole('button', { name: 'Show On screen area details' }).click()
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { offscreenRailTest: { selections: string[] } })
          .offscreenRailTest.selections,
    ),
  ).toEqual(['on-screen-area'])

  await rail.getByRole('button', { name: 'Center map on Close Exact' }).click()
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                offscreenRailTest: {
                  camera: { longitude: number; latitude: number; zoom: number }[]
                }
              }
            ).offscreenRailTest.camera.at(-1)?.longitude,
        ),
      { timeout: 15_000 },
    )
    .toBeCloseTo(9, 1)

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      offscreenRailTest?: { app: { unmount: () => void }; container: HTMLElement }
    }
    testWindow.offscreenRailTest?.app.unmount()
    testWindow.offscreenRailTest?.container.remove()
    delete testWindow.offscreenRailTest
  })
})
