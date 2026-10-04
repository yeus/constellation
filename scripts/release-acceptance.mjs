import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { androidArtifactName } from './copy-android-apk.mjs'
import { desktopArtifactName } from './copy-desktop-artifact.mjs'

const root = path.resolve(import.meta.dirname, '..')
const toolAvailable = (name) =>
  spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', name], { stdio: 'ignore' })
    .status === 0
const tools = [
  'node',
  'nix',
  'adb',
  'apksigner',
  'flatpak',
  'flatpak-builder',
  'appstreamcli',
  'secret-tool',
  'gh',
]
const timestamp = new Date().toISOString()
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const desktopName = desktopArtifactName(version, 'x86_64')
const report = {
  kind: 'host-readiness-only',
  timestamp,
  tools: Object.fromEntries(tools.map((name) => [name, toolAvailable(name)])),
  artifacts: Object.fromEntries(
    [
      androidArtifactName('release', 'aarch64'),
      desktopName,
      desktopName.replace(/\.AppImage$/, '.flatpak'),
    ].map((name) => [name, existsSync(path.join(root, 'dist', name))]),
  ),
  runtimeAcceptance: 'not-run',
}
const filename = `release-acceptance-${timestamp.replace(/[:.]/g, '-')}.json`
writeFileSync(path.join(root, filename), `${JSON.stringify(report, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
})
console.log(`Wrote ${filename}. See docs/RELEASE_0_1_ACCEPTANCE.md for runtime checks.`)
