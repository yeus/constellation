import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const ci = () => fs.readFileSync('.github/workflows/ci.yml', 'utf8')
const release = () => fs.readFileSync('.github/workflows/release.yml', 'utf8')
const publisher = () => fs.readFileSync('scripts/publish-github-release.sh', 'utf8')

test('workflow names identify website deployment and application publishing', () => {
  assert.match(ci(), /^name: Checks and Deploy Website\n/)
  assert.match(release(), /^name: Build and Publish Apps\n/)
})

test('screenshots are previews in CI and required image assets in releases', () => {
  for (const workflow of [ci(), release()]) {
    const job = workflow.slice(
      workflow.indexOf('  screenshots:'),
      workflow.indexOf('  screenshots:') + 1800,
    )
    assert.match(job, /corepack yarn screenshots/)
    assert.match(job, /include-hidden-files: true/)
    assert.match(job, /path: \.screenshots\/\*\.png/)
    assert.match(job, /if-no-files-found: error/)
  }
  const pages = ci().slice(ci().indexOf('  pages-build:'))
  assert.doesNotMatch(pages, /- screenshots/)
  const publish = release().slice(release().indexOf('  publish:'))
  assert.match(publish, /- screenshots/)
  for (const name of ['welcome', 'share', 'following']) {
    assert.ok(publish.includes(`test -s "release-assets/constellation-${name}.png"`))
  }
  assert.match(publisher(), /image\/png/)
})

test('GitHub Actions owns quality, browser regression, and Pages deployment', () => {
  assert.equal(fs.existsSync('.gitlab-ci.yml'), false)

  const workflow = ci()
  assert.doesNotMatch(workflow, /\\\$\{/)
  for (const command of [
    'corepack yarn format:check',
    'corepack yarn lint',
    'corepack yarn test',
    'corepack yarn test:android:config',
    'corepack yarn build',
    'corepack yarn playwright test tests/share-flow.spec.ts --workers=1',
    'corepack yarn playwright test tests/p2p-share.spec.ts --project=desktop --workers=1',
    'corepack yarn test:pages',
  ]) {
    assert.ok(workflow.includes(command), 'workflow must run ' + command)
  }
  assert.match(workflow, /actions\/configure-pages@v5/)
  assert.match(workflow, /actions\/upload-pages-artifact@v4/)
  assert.match(workflow, /actions\/deploy-pages@v4/)
  assert.match(workflow, /secrets\.ANDROID_APP_LINK_SHA256/)
})

test('browser regression builds vendor packages before starting Playwright', () => {
  const workflow = ci()
  const job = workflow.slice(
    workflow.indexOf('browser-regression:'),
    workflow.indexOf('pages-build:'),
  )
  const vendor = job.indexOf('corepack yarn build:vendor')
  const playwright = job.indexOf('corepack yarn playwright test tests/share-flow.spec.ts')
  assert.ok(vendor !== -1, 'browser regression must build the vendored packages')
  assert.ok(playwright !== -1, 'browser regression must run the share-flow spec')
  assert.ok(vendor < playwright, 'vendored packages must be built before Playwright starts')
})

test('quality job builds vendor packages before linting', () => {
  const workflow = ci()
  const job = workflow.slice(
    workflow.indexOf('  quality:'),
    workflow.indexOf('  browser-regression:'),
  )
  const vendor = job.indexOf('corepack yarn build:vendor')
  const lint = job.indexOf('corepack yarn lint')
  assert.ok(vendor !== -1, 'quality must build the vendored packages')
  assert.ok(lint !== -1, 'quality must run lint')
  assert.ok(vendor < lint, 'vendored packages must be built before lint runs')
})

test('tagged GitHub releases build Android and both Linux packages before publishing', () => {
  const workflow = release()
  assert.doesNotMatch(workflow, /\\\$\{/)
  assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/)
  assert.match(workflow, /nix run \.#build-desktop-release-appimage/)
  assert.match(workflow, /corepack yarn build:desktop:release:flatpak/)
  assert.match(workflow, /corepack yarn build:android:release/)
  assert.match(workflow, /secrets\.ANDROID_KEYSTORE_BASE64/)
  assert.match(workflow, /SHA256SUMS/)
  assert.match(workflow, /scripts\/publish-github-release\.sh/)
  assert.doesNotMatch(publisher(), /\\\$\{/)
})

test('release jobs install dependencies before invoking repository build tools', () => {
  const workflow = release()
  const appimage = workflow.slice(workflow.indexOf('appimage:'), workflow.indexOf('flatpak:'))
  const install = appimage.indexOf('corepack yarn install --immutable')
  const build = appimage.indexOf('nix run .#build-desktop-release-appimage')
  assert.ok(install !== -1, 'the AppImage job must install dependencies')
  assert.ok(build !== -1, 'the AppImage job must run the flake builder')
  assert.ok(install < build, 'the AppImage job must install dependencies before nix run')
})

test('Flatpak release job installs elfutils for Flatpak debug-info processing', () => {
  const workflow = release()
  const flatpak = workflow.slice(workflow.indexOf('  flatpak:'), workflow.indexOf('  android:'))
  const installStart = flatpak.indexOf('sudo apt-get install')
  const installEnd = flatpak.indexOf('- name: Setup Node.js')
  const install = flatpak.slice(installStart, installEnd)
  const build = flatpak.indexOf('corepack yarn build:desktop:release:flatpak')
  assert.ok(installStart !== -1 && installEnd !== -1, 'the Flatpak job must install its tools')
  assert.match(install, /\belfutils\b/, 'the install step must include elfutils')
  assert.ok(build !== -1, 'the Flatpak job must build the package')
  assert.ok(installEnd < build, 'Flatpak build tools must be installed before building')
})

test('release jobs use the Android SDK action that skips the removed tools package', () => {
  const workflow = release()
  assert.match(workflow, /android-actions\/setup-android@v4/)
  assert.doesNotMatch(workflow, /android-actions\/setup-android@v3/)
})
