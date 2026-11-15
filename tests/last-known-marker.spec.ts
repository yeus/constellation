import { expect, test } from '@playwright/test'

test('map preserves last known peer avatar with clock badge and restores live styling on a fresh fix', async ({
  page,
}) => {
  await page.route('**/*.pmtiles*', (route) => route.abort())
  await page.goto('/')
  await page.evaluate(async () => {
    const vueUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/node_modules/.vite/deps/vue.js'))?.name
    if (!vueUrl) throw new Error('Vue module unavailable in browser fixture.')
    const { createApp, h, ref } = await import(/* @vite-ignore */ vueUrl)
    const { default: LocationMap } = await import('../src/components/LocationMap.vue')
    const now = Date.now()
    const location = {
      id: 'synthetic-peer',
      label: 'Last known person',
      longitude: 0,
      latitude: 0,
      precision: 'exact' as const,
      accuracyMeters: 5,
      capturedAt: now - 3 * 60 * 60_000,
      expiresAt: now - 3 * 60 * 60_000 + 15_000,
      state: 'stale' as const,
    }
    const locations = ref([location])
    const container = document.createElement('div')
    container.id = 'last-known-marker-test'
    Object.assign(container.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: '320px',
      height: '360px',
      zIndex: '9999',
    })
    document.body.append(container)
    const app = createApp({
      render: () =>
        h(LocationMap, {
          locations: locations.value,
          initialCamera: { latitude: 0, longitude: 0, zoom: 6 },
          decluttering: {
            enabled: false,
            groupMarkerCollisions: false,
            groupUncertaintyOverlap: false,
            uncertaintyOverlapThreshold: 0.45,
            markerCollisionDistancePx: 48,
          },
        }),
    })
    app.mount(container)
    Object.assign(window, { lastKnownMarkerTest: { app, container, locations } })
  })

  const fixture = page.locator('#last-known-marker-test')
  const marker = fixture.getByRole('button', {
    name: /Show Last known person details\. Last known · 3h/,
  })
  await expect(marker).toBeVisible({ timeout: 30_000 })
  await expect(marker.locator('.map-peer-avatar__clock')).toBeVisible()
  await expect(marker.locator('.map-peer-avatar__portrait')).toHaveCSS('opacity', '0.45')

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      lastKnownMarkerTest: {
        app: { unmount: () => void }
        container: HTMLElement
        locations: { value: Array<Record<string, unknown>> }
      }
    }
    const location = testWindow.lastKnownMarkerTest.locations.value[0]!
    testWindow.lastKnownMarkerTest.locations.value = [
      {
        ...location,
        capturedAt: Date.now(),
        expiresAt: Date.now() + 15_000,
        state: 'live',
      },
    ]
  })
  await expect(fixture.locator('.map-peer-avatar__clock')).toHaveCount(0)
  await expect(fixture.locator('.map-peer-avatar__portrait')).toHaveCSS('opacity', '1')
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      lastKnownMarkerTest?: { app: { unmount: () => void }; container: HTMLElement }
    }
    testWindow.lastKnownMarkerTest?.app.unmount()
    testWindow.lastKnownMarkerTest?.container.remove()
    delete testWindow.lastKnownMarkerTest
  })
})
