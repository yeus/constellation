import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const run = (command, args) => spawnSync(command, args, { stdio: 'inherit' })

const findAppstreamCli = () => {
  if (spawnSync('which', ['appstreamcli']).status === 0) return 'appstreamcli'
  const store = '/nix/store'
  if (!fs.existsSync(store)) return undefined
  return fs
    .readdirSync(store)
    .filter((entry) => /-appstream-/.test(entry))
    .sort()
    .map((entry) => path.join(store, entry, 'bin', 'appstreamcli'))
    .find((candidate) => fs.existsSync(candidate))
}

const appstreamCli = findAppstreamCli()

let failed = false

console.log('Validating Flatpak manifest and generated dependency sources...')
if (
  run(process.execPath, [
    '--test',
    'scripts/flatpak-manifest.test.mjs',
    'scripts/flatpak-submission-manifest.test.mjs',
  ]).status !== 0
) {
  failed = true
}

if (appstreamCli) {
  console.log(`Validating MetaInfo with ${appstreamCli}...`)
  if (
    run(appstreamCli, [
      'validate',
      '--no-net',
      'packaging/flatpak/space.taskyon.constellation.metainfo.xml',
    ]).status !== 0
  ) {
    failed = true
  }
} else {
  console.error('appstreamcli is unavailable; MetaInfo validation was skipped.')
  failed = true
}

if (spawnSync('which', ['flatpak-builder-lint']).status !== 0) {
  console.log(
    'flatpak-builder-lint is unavailable; install it from flatpak/flatpak-builder-tools to run the Flathub linter.',
  )
}

if (failed) process.exitCode = 1
else console.log('Flatpak lint checks passed.')
