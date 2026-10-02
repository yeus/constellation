import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { chromium } from '@playwright/test'

import { browserProcessEnvironment } from './browser-environment.mjs'
import { preparePages, tauriIdentifier } from './prepare-pages.mjs'

const distDir = path.resolve('dist')
const publicUrl = 'https://constellation.taskyon.space/'
const syntheticFingerprint = Array(32).fill('AB').join(':')
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const readDist = (file) => fs.readFileSync(path.join(distDir, file), 'utf8')

const assertStaticArtifact = () => {
  const index = readDist('index.html')
  const fallback = readDist('404.html')
  assert.equal(fallback, index, 'the SPA fallback must equal the built entry')

  const references = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  assert.ok(references.length > 0, 'the built entry must reference its assets')
  for (const reference of references) {
    assert.ok(reference.startsWith('/'), `asset ${reference} must be root-host absolute`)
    assert.ok(!reference.includes('://'), `asset ${reference} must stay same-origin`)
    assert.ok(fs.existsSync(path.join(distDir, reference)), `asset ${reference} must exist`)
  }
  assert.doesNotMatch(index, /localhost|127\.0\.0\.1|file:\/\/|\/workspace\//)

  const appBundle = references.find(
    (reference) => reference.startsWith('/assets/') && reference.endsWith('.js'),
  )
  assert.ok(appBundle, 'the built entry must reference an application bundle')
  const bundle = fs.readFileSync(path.join(distDir, appBundle), 'utf8')
  assert.ok(bundle.includes(publicUrl), 'the configured public URL must be baked into the bundle')
  assert.ok(!bundle.includes('/ip4/127.0.0.1/tcp/9111/ws'), 'no local relay address')
  assert.ok(!bundle.includes('/workspace/'), 'no local workspace paths')

  assert.ok(fs.existsSync(path.join(distDir, 'legacy-compat.js')))
  assert.ok(fs.existsSync(path.join(distDir, 'map-assets', 'sprites', 'v4', 'light.json')))
}

const assertAppLinksConsistency = () => {
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const deepLink = config.plugins?.['deep-link']?.mobile?.[0]
  assert.ok(deepLink, 'the Tauri deep-link configuration is required')
  assert.deepEqual(deepLink.scheme, ['https'])
  assert.equal(deepLink.host, 'constellation.taskyon.space')
  assert.equal(deepLink.appLink, true)

  const manifest = fs.readFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8')
  assert.match(manifest, /android:scheme="https"/)
  assert.match(manifest, /android:host="constellation\.taskyon\.space"/)
  assert.match(manifest, /android:autoVerify="true"/)

  const buildGradle = fs.readFileSync('src-tauri/gen/android/app/build.gradle.kts', 'utf8')
  assert.match(
    buildGradle,
    new RegExp(`applicationId\\s*=\\s*"${tauriIdentifier().replaceAll('.', '\\.')}"`),
  )

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-applinks-'))
  try {
    fs.copyFileSync(path.join(distDir, 'index.html'), path.join(tempDir, 'index.html'))
    const { assetLinks } = preparePages({
      distDir: tempDir,
      fingerprint: syntheticFingerprint,
      packageName: tauriIdentifier(),
      warn: () => undefined,
    })
    const written = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.well-known', 'assetlinks.json'), 'utf8'),
    )
    assert.deepEqual(written, assetLinks)
    assert.equal(written[0].target.package_name, tauriIdentifier())
    assert.deepEqual(written[0].relation, ['delegate_permission/common.handle_all_urls'])
    assert.deepEqual(written[0].target.sha256_cert_fingerprints, [syntheticFingerprint])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

const startStaticServer = async () => {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`)
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const candidate = path.resolve(distDir, relative)
    if (
      candidate.startsWith(distDir) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(candidate)] ?? 'application/octet-stream',
      })
      fs.createReadStream(candidate).pipe(response)
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    fs.createReadStream(path.join(distDir, '404.html')).pipe(response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, requests, origin: `http://127.0.0.1:${address.port}` }
}

const assertBuiltApp = async (browser, origin, requests) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  const boot = async (url) => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    try {
      await page.getByRole('button', { name: 'Share location' }).waitFor({ timeout: 60_000 })
    } catch (error) {
      const body = await page.textContent('body').catch(() => '')
      throw new Error(
        `the built app did not boot at ${url}: ${JSON.stringify({ pageErrors, body: body?.slice(0, 400) })}`,
        { cause: error },
      )
    }
    return response
  }

  const rootResponse = await boot(`${origin}/`)
  assert.equal(rootResponse.status(), 200)
  await page.locator('.maplibregl-canvas').waitFor({ timeout: 30_000 })

  const unknownResponse = await boot(`${origin}/synthetic/unknown/path`)
  assert.equal(unknownResponse.status(), 404, 'unknown paths use the Pages 404 fallback')

  const capability = {
    v: 1,
    shareId: randomBytes(16).toString('base64url'),
    secret: randomBytes(32).toString('base64url'),
    sourcePeerId: '12D3KooWHdsAgRqDXk1pyA6Stc2pXf1VFUpvuLDUXKq2mdLWT81B',
    addresses: [
      '/ip4/192.0.2.10/tcp/4001/ws/p2p/12D3KooWLQh43ZtMVc8WyqJKim22EsnNxVoP6ncojZURTDi5FjWx',
    ],
    expiresAt: Date.now() + 3_600_000,
  }
  const fragment = Buffer.from(JSON.stringify(capability)).toString('base64url')
  const fragmentUrl = `${origin}/#share=${fragment}`
  const fragmentResponse = await page.goto(fragmentUrl, { waitUntil: 'domcontentloaded' })
  assert.equal(fragmentResponse.status(), 200)
  await page.waitForFunction(() => document.body.innerText.includes('192.0.2.10:4001'), undefined, {
    timeout: 60_000,
  })
  const fragmentBody = await page.textContent('body')
  assert.equal(fragmentBody.includes('invalid or expired'), false)
  assert.equal(await page.evaluate(() => location.hash), `#share=${fragment}`)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('192.0.2.10:4001'), undefined, {
    timeout: 60_000,
  })
  assert.equal(await page.evaluate(() => location.hash), `#share=${fragment}`)
  assert.ok(
    requests.every((request) => !request.includes('#') && !request.includes('share=')),
    'the static server must never receive the share fragment',
  )
  assert.deepEqual(pageErrors, [], 'the built app must not raise uncaught errors')

  await context.close()
}

assertStaticArtifact()
assertAppLinksConsistency()

const { server, requests, origin } = await startStaticServer()
let browser
try {
  browser = await chromium.launch({ env: browserProcessEnvironment(process.env) })
  await assertBuiltApp(browser, origin, requests)
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}

console.log('Pages preflight passed.')
