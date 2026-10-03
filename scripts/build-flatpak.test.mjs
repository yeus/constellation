import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('builds the stable Flatpak bundle with a Flathub remote', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-flatpak-test-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))

  const scriptsDir = path.join(fixtureRoot, 'scripts')
  const fakeBin = path.join(fixtureRoot, 'bin')
  const callLog = path.join(fixtureRoot, 'flatpak-calls')
  fs.mkdirSync(scriptsDir)
  fs.mkdirSync(fakeBin)
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/build-flatpak.sh'),
    path.join(scriptsDir, 'build-flatpak.sh'),
  )
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  fs.writeFileSync(
    path.join(fakeBin, 'flatpak'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'flatpak %s\n' "$*" >> "$FLATPAK_CALL_LOG"
case "$1" in
  remotes) exit 0 ;;
  --default-arch) printf 'x86_64\n' ;;
esac
`,
  )
  fs.writeFileSync(
    path.join(fakeBin, 'flatpak-builder'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'flatpak-builder %s\n' "$*" >> "$FLATPAK_CALL_LOG"
printf 'build-commit=%s\n' "\${CONSTELLATION_BUILD_COMMIT-unset}" >> "$FLATPAK_CALL_LOG"
`,
  )
  fs.chmodSync(path.join(fakeBin, 'flatpak'), 0o755)
  fs.chmodSync(path.join(fakeBin, 'flatpak-builder'), 0o755)

  const result = spawnSync('bash', [path.join(scriptsDir, 'build-flatpak.sh')], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FLATPAK_CALL_LOG: callLog,
      GITHUB_SHA: 'a'.repeat(40),
    },
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const calls = fs.readFileSync(callLog, 'utf8')
  assert.match(calls, /flatpak remote-add --user --if-not-exists flathub /)
  assert.match(calls, /flatpak-builder .*--default-branch=stable /)
  assert.match(calls, new RegExp(`build-commit=${'a'.repeat(40)}`))
  assert.match(
    calls,
    /flatpak build-bundle .*constellation-desktop-0\.1\.0-x86_64\.flatpak space\.taskyon\.constellation stable /,
  )
})

test('Nix Flatpak build environments provide elfutils', () => {
  const flake = fs.readFileSync(path.join(projectRoot, 'flake.nix'), 'utf8')
  const appStart = flake.indexOf('buildFlatpakScript =')
  const appEnd = flake.indexOf('\n      in', appStart)
  const shellStart = flake.indexOf('devShells.default = pkgs.mkShell')
  const shellEnd = flake.indexOf(
    '++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.libsecret',
    shellStart,
  )
  const app = flake.slice(appStart, appEnd)
  const shell = flake.slice(shellStart, shellEnd)

  assert.ok(appStart !== -1 && appEnd !== -1, 'the flake must define its Flatpak app')
  assert.ok(shellStart !== -1 && shellEnd !== -1, 'the flake must define its development shell')
  assert.match(app, /\$\{pkgs\.elfutils\}\/bin/, 'the Flatpak app must expose eu-strip')
  assert.match(shell, /^\s+elfutils\s*$/m, 'the development shell must provide elfutils')
})
