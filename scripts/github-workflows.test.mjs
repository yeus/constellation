import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const ci = () => fs.readFileSync('.github/workflows/ci.yml', 'utf8')
const release = () => fs.readFileSync('.github/workflows/release.yml', 'utf8')
const publisher = () => fs.readFileSync('scripts/publish-github-release.sh', 'utf8')

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
