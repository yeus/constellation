import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('builds with a fresh Cargo target and copies the AppImage to dist', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-appimage-test-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  const scriptsDir = path.join(fixtureRoot, 'scripts')
  const fakeBin = path.join(fixtureRoot, 'bin')
  const staleTarget = path.join(fixtureRoot, 'stale-target')
  const targetLog = path.join(fixtureRoot, 'target-path')
  const yarnLog = path.join(fixtureRoot, 'yarn-arguments')
  fs.mkdirSync(scriptsDir)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(path.join(staleTarget, 'release/bundle/appimage'), { recursive: true })
  fs.writeFileSync(
    path.join(staleTarget, 'release/bundle/appimage/zzz-old.AppImage'),
    'stale appimage',
  )
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/build-appimage.sh'),
    path.join(scriptsDir, 'build-appimage.sh'),
  )
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/copy-desktop-artifact.mjs'),
    path.join(scriptsDir, 'copy-desktop-artifact.mjs'),
  )
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  fs.writeFileSync(
    path.join(fakeBin, 'yarn'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$APPIMAGE_YARN_LOG"
test "$CARGO_TARGET_DIR" != "$APPIMAGE_STALE_TARGET"
printf '%s' "$CARGO_TARGET_DIR" > "$APPIMAGE_TARGET_LOG"
mkdir -p "$CARGO_TARGET_DIR/release/bundle/appimage"
printf 'fresh appimage' > "$CARGO_TARGET_DIR/release/bundle/appimage/constellation.AppImage"
`,
  )
  fs.chmodSync(path.join(fakeBin, 'yarn'), 0o755)

  const result = spawnSync('bash', [path.join(scriptsDir, 'build-appimage.sh')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      CARGO_TARGET_DIR: staleTarget,
      APPIMAGE_STALE_TARGET: staleTarget,
      APPIMAGE_TARGET_LOG: targetLog,
      APPIMAGE_YARN_LOG: yarnLog,
    },
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(fs.readFileSync(yarnLog, 'utf8'), /build:desktop:appimage:internal/)
  assert.equal(
    fs.readFileSync(
      path.join(fixtureRoot, 'dist/constellation-desktop-0.1.0-x86_64.AppImage'),
      'utf8',
    ),
    'fresh appimage',
  )
  assert.equal(fs.existsSync(fs.readFileSync(targetLog, 'utf8')), false)
  assert.equal(
    fs.readFileSync(path.join(staleTarget, 'release/bundle/appimage/zzz-old.AppImage'), 'utf8'),
    'stale appimage',
  )
})
