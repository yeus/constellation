import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const quickCommands = [
  ['install', '--immutable'],
  ['format:check'],
  ['build:vendor'],
  ['lint'],
  ['test'],
  ['test:android:config'],
  ['build'],
  ['release:check'],
]

const browserCommands = [
  ['playwright', 'test', 'tests/share-flow.spec.ts', '--workers=1'],
  ['playwright', 'test', 'tests/p2p-share.spec.ts', '--project=desktop', '--workers=1'],
  ['playwright', 'test', 'tests/map-ui.spec.ts', '--workers=1'],
  ['playwright', 'test', 'tests/sharing-diagnostics.spec.ts', '--workers=1'],
  ['test:pages'],
]

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const assertCleanCheckout = (root) => {
  if (git(root, 'status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error(
      'Full CI preflight requires a clean Git checkout. Commit your staged and unstaged changes first; use yarn ci:quick to validate work in progress.',
    )
  }
  return git(root, 'rev-parse', 'HEAD')
}

const yarn = (root, args) => {
  console.log(`> corepack yarn ${args.join(' ')}`)
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`CI command failed: yarn ${args.join(' ')} (${result.signal ?? result.status})`)
  }
}

const assertScreenshots = (root, startedAt) => {
  const directory = path.join(root, '.screenshots')
  let screenshots = []
  try {
    screenshots = readdirSync(directory).filter(
      (name) =>
        name.endsWith('.png') && statSync(path.join(directory, name)).mtimeMs >= startedAt - 1000,
    )
  } catch {
    // Missing screenshot directory is handled by the assertion below.
  }
  if (!screenshots.length) throw new Error('Screenshot CI job produced no new PNG artifacts.')
}

const main = () => {
  const mode = process.argv[2]
  if (!['quick', 'preflight'].includes(mode) || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/ci-preflight.mjs quick|preflight')
  }
  const root = process.cwd()
  const revision = mode === 'preflight' ? assertCleanCheckout(root) : null
  console.log(
    mode === 'preflight'
      ? `Validating committed revision ${revision}`
      : 'Running Quality checks on the working tree.',
  )
  for (const command of quickCommands) yarn(root, command)
  if (mode === 'quick') return

  for (const command of browserCommands) yarn(root, command)
  const screenshotStart = Date.now()
  yarn(root, ['screenshots'])
  assertScreenshots(root, screenshotStart)

  if (assertCleanCheckout(root) !== revision) {
    throw new Error('HEAD changed during preflight; re-run on the commit you intend to push.')
  }
  console.log(`Committed revision validated: ${revision}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
