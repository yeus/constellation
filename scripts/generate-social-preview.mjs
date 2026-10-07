import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await fs.readFile(path.join(repositoryRoot, 'public/social-preview.svg'), 'utf8')
const browser = await chromium.launch({ headless: true })

try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  })
  await page.setContent(`<html><body style="margin:0">${source}</body></html>`)
  await page.locator('svg').screenshot({
    path: path.join(repositoryRoot, 'public/social-preview.png'),
  })
} finally {
  await browser.close()
}
