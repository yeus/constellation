import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const manifest = fs.readFileSync('packaging/flatpak/space.taskyon.constellation.yml', 'utf8')
const metainfo = fs.readFileSync(
  'packaging/flatpak/space.taskyon.constellation.metainfo.xml',
  'utf8',
)
const yarnLock = fs.readFileSync('yarn.lock', 'utf8')
const yarnSources = JSON.parse(fs.readFileSync('packaging/flatpak/generated-sources.json', 'utf8'))
const cargoSources = JSON.parse(fs.readFileSync('packaging/flatpak/cargo-sources.json', 'utf8'))

test('local Flatpak manifest builds offline from pinned dependency sources', () => {
  assert.match(manifest, /runtime-version: '51'/)
  assert.doesNotMatch(manifest, /build-args:/)
  assert.match(manifest, /CARGO_NET_OFFLINE: 'true'/)
  assert.match(manifest, /YARN_ENABLE_NETWORK: '0'/)
  assert.match(manifest, /YARN_ENABLE_GLOBAL_CACHE: '1'/)
  assert.match(manifest, /secret-env:\s*\n\s*- CONSTELLATION_BUILD_COMMIT/)
  assert.match(manifest, /yarn-4\.16\.0\.cjs/)
  assert.doesNotMatch(manifest, /yarn-4\.16\.0\.js/)
  assert.match(manifest, /plugin import \.\/flatpak-node\/flatpak-yarn\.js/)
  assert.doesNotMatch(manifest, /plugin import flatpak-node/)
  const pluginImport = manifest.indexOf('plugin import ./flatpak-node/flatpak-yarn.js')
  const convertArchives = manifest.indexOf('convertToZip')
  const install = manifest.indexOf('install --immutable')
  assert.ok(pluginImport !== -1, 'the Flatpak Yarn plugin must be imported')
  assert.ok(convertArchives !== -1, 'the pinned Yarn tarballs must be converted to cache archives')
  assert.ok(install !== -1, 'the immutable Yarn install must run')
  assert.ok(pluginImport < convertArchives, 'the plugin must be imported before cache conversion')
  assert.ok(convertArchives < install, 'the cache must be converted before the offline install')
  assert.match(manifest, /generated-sources\.json/)
  assert.match(manifest, /cargo-sources\.json/)
  assert.match(manifest, /# BEGIN local-source/)
  assert.match(manifest, /# END local-source/)
  assert.match(manifest, /- --share=network/)
  assert.match(manifest, /- --talk-name=org\.freedesktop\.secrets/)
})

test('generated Yarn sources are pinned and include the Flatpak plugin', () => {
  assert.ok(Array.isArray(yarnSources) && yarnSources.length > 0)
  const plugin = yarnSources.find((entry) => entry.dest === 'flatpak-node')
  assert.ok(plugin, 'the Flatpak Yarn plugin source must be generated')
  assert.match(plugin.contents, /yarn_v1 = Option\.String\(\{ required: false \}\)/)
  assert.match(plugin.contents, /Yarn Classic Git dependencies require a Yarn Classic CLI/)
  for (const entry of yarnSources) {
    if (entry.type === 'archive') {
      assert.ok(entry.url, 'archive sources need a URL')
      assert.ok(entry.sha256 || entry.sha512, 'archive sources need a checksum')
    }
    if (entry.type === 'file') {
      assert.ok(entry.url && entry.sha512, 'file sources need a URL and checksum')
    }
  }
})

test('generated Yarn sources cover every registry locator in yarn.lock', () => {
  const registryLocators = [...yarnLock.matchAll(/^ {2}resolution: "([^"]+)"$/gm)]
    .map((match) => match[1])
    .filter((resolution) => resolution.includes('@npm:'))
  const generatedFilenames = yarnSources
    .filter(
      (entry) => entry.type === 'file' && entry.dest === 'flatpak-node/yarn-berry/cache/locator',
    )
    .map((entry) => entry['dest-filename'])
  const missing = registryLocators.filter((resolution) => {
    const encodedLocator = Buffer.from(resolution).toString('base64')
    return !generatedFilenames.some((filename) => filename.includes(encodedLocator))
  })

  assert.ok(registryLocators.length > 0, 'yarn.lock must contain registry package locators')
  assert.deepEqual(missing, [], 'every Yarn registry locator needs a generated offline source')
})

test('generated Cargo sources vendor every registry package with a checksum', () => {
  assert.ok(Array.isArray(cargoSources) && cargoSources.length > 0)
  const config = cargoSources.find(
    (entry) => entry.dest === 'cargo' && entry['dest-filename'] === 'config',
  )
  assert.ok(config, 'the vendored-sources Cargo config must be generated')
  assert.match(config.contents, /vendored-sources/)
  for (const entry of cargoSources) {
    if (entry.type !== 'archive') continue
    assert.ok(
      entry.url?.startsWith('https://static.crates.io/'),
      'crate archives must come from crates.io',
    )
    assert.ok(entry.sha256, 'crate archives need a SHA-256 checksum')
  }

  const lockfile = fs.readFileSync('src-tauri/Cargo.lock', 'utf8')
  const registryPackages = lockfile
    .split('[[package]]')
    .slice(1)
    .filter((block) => /source = "registry\+/.test(block))
    .map(
      (block) =>
        `${block.match(/name = "([^"]+)"/)?.[1]}-${block.match(/version = "([^"]+)"/)?.[1]}`,
    )
  const vendored = new Set(
    cargoSources
      .filter((entry) => entry.type === 'archive')
      .map((entry) => (entry.dest ?? '').replace('cargo/vendor/', '')),
  )
  const missing = registryPackages.filter((pkg) => !vendored.has(pkg))
  assert.deepEqual(missing, [], 'every Cargo.lock registry package must have a vendored source')
})

test('MetaInfo carries release, screenshot, and identity metadata', () => {
  assert.match(metainfo, /<id>space\.taskyon\.constellation<\/id>/)
  assert.match(metainfo, /<project_license>MIT<\/project_license>/)
  assert.match(metainfo, /<release version="0\.1\.0" date="\d{4}-\d{2}-\d{2}" \/>/)
  assert.match(
    metainfo,
    /<image>https:\/\/raw\.githubusercontent\.com\/yeus\/constellation\/main\/packaging\/flatpak\/screenshots\/constellation-desktop\.png<\/image>/,
  )
  assert.match(metainfo, /<developer id="space\.taskyon">/)
  assert.ok(fs.existsSync('packaging/flatpak/screenshots/constellation-desktop.png'))
})
