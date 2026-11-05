import { defineConfig, devices } from '@playwright/test'

import { browserProcessEnvironment } from './scripts/browser-environment.mjs'

export default defineConfig({
  testDir: './tests',
  testIgnore: 'screenshots.spec.ts',
  // Real P2P integration shares a local relay; eight concurrent browser
  // workers caused unrelated share creation and map timing failures.
  // Keep retries disabled so failures remain visible; override workers explicitly
  // for performance experiments rather than turning races into passes.
  workers: 2,
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: { env: browserProcessEnvironment(process.env) },
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: [
    {
      command: 'node scripts/e2e-relay.mjs',
      url: 'http://127.0.0.1:9113/health',
      stdout: 'ignore',
      stderr: 'ignore',
      reuseExistingServer: false,
    },
    {
      command: 'corepack yarn vite --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      env: { VITE_CONSTELLATION_RELAY_ADDRS: '/ip4/127.0.0.1/tcp/9111/ws' },
      reuseExistingServer: false,
    },
  ],
})
