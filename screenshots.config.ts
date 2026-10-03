import { defineConfig } from '@playwright/test'

import config from './playwright.config.ts'

export default defineConfig({
  ...config,
  testMatch: 'screenshots.spec.ts',
  testIgnore: [],
  workers: 1,
  retries: 0,
  projects: [
    {
      name: 'screenshots',
      use: {
        viewport: { width: 430, height: 860 },
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'UTC',
        contextOptions: { reducedMotion: 'reduce' },
        geolocation: { latitude: 48.1372, longitude: 11.5756 },
        permissions: ['geolocation'],
      },
    },
  ],
  use: { ...config.use, trace: 'off', screenshot: 'off', video: 'off' },
})
