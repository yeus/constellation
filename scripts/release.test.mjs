import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versionFiles = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/plugins/constellation-android/Cargo.toml',
  'packaging/flatpak/space.taskyon.constellation.metainfo.xml',
]

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

const applicationVersion = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

const nextPatchVersion = (root) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(applicationVersion(root))
  if (!match) throw new Error('Expected a synthetic semantic application version.')
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`
}

const makeReleaseRepository = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-release-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const relativePath of versionFiles) {
    const destination = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(repositoryRoot, relativePath), destination)
  }
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(
    path.join(repositoryRoot, 'scripts/release.mjs'),
    path.join(root, 'scripts/release.mjs'),
  )
  const metainfoPath = path.join(root, 'packaging/flatpak/space.taskyon.constellation.metainfo.xml')
  const metainfo = fs.readFileSync(metainfoPath, 'utf8')
  fs.writeFileSync(
    metainfoPath,
    metainfo.replace(
      '</releases>',
      '    <release version="0.0.9" date="2026-01-01" />\n  </releases>',
    ),
  )
  git(root, 'init', '--quiet', '--initial-branch=main')
  git(root, 'config', 'user.name', 'Constellation release fixture')
  git(root, 'config', 'user.email', 'release-fixture@example.invalid')
  git(root, 'config', 'tag.gpgSign', 'false')
  git(root, 'add', '--all')
  git(root, 'commit', '--quiet', '-m', 'fixture baseline')
  return root
}

const runRelease = (root, ...args) =>
  spawnSync(process.execPath, ['scripts/release.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    input: '',
  })

test('release check detects version drift across package, Tauri, Cargo, and AppStream', (context) => {
  const root = makeReleaseRepository(context)
  const valid = runRelease(root, '--check')
  assert.equal(valid.status, 0, valid.stderr)

  const tauriPath = path.join(root, 'src-tauri/tauri.conf.json')
  const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf8'))
  const currentVersion = applicationVersion(root)
  const mismatchedVersion = nextPatchVersion(root)
  tauri.version = mismatchedVersion
  fs.writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`)
  const invalid = runRelease(root, '--check')
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /src-tauri\/tauri\.conf\.json.*expected/i)

  tauri.version = currentVersion
  fs.writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`)
  const metainfoPath = path.join(root, 'packaging/flatpak/space.taskyon.constellation.metainfo.xml')
  const metainfo = fs.readFileSync(metainfoPath, 'utf8')
  fs.writeFileSync(
    metainfoPath,
    metainfo.replace(
      `<release version="${currentVersion}"`,
      `<release version="${mismatchedVersion}"`,
    ),
  )
  const staleAppstream = runRelease(root, '--check')
  assert.notEqual(staleAppstream.status, 0)
  assert.match(staleAppstream.stderr, /metainfo\.xml latest release.*expected/i)
})

test('dry run previews a release without changing files or creating a tag', (context) => {
  const root = makeReleaseRepository(context)
  const targetVersion = nextPatchVersion(root)
  const before = versionFiles.map((relativePath) =>
    fs.readFileSync(path.join(root, relativePath), 'utf8'),
  )
  const result = runRelease(root, targetVersion, '--dry-run')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`Would prepare release ${targetVersion}`))
  assert.deepEqual(
    versionFiles.map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')),
    before,
  )
  assert.equal(git(root, 'tag', '--list', `v${targetVersion}`), '')
})

test('release updates metadata, preserves AppStream history, and creates a local commit and tag', (context) => {
  const root = makeReleaseRepository(context)
  const currentVersion = applicationVersion(root)
  const targetVersion = nextPatchVersion(root)
  const originalJsonMetadata = ['package.json', 'src-tauri/tauri.conf.json'].map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(root, relativePath), 'utf8'),
  ])
  const result = runRelease(root, targetVersion, '--yes')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`Release metadata is consistent at version ${targetVersion}`))
  assert.ok(result.stdout.includes(`Release commit and tag created locally: v${targetVersion}`))
  assert.ok(result.stdout.includes(`git push origin main v${targetVersion}`))

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')
  const pluginCargo = fs.readFileSync(
    path.join(root, 'src-tauri/plugins/constellation-android/Cargo.toml'),
    'utf8',
  )
  const cargoLock = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8')
  const metainfo = fs.readFileSync(
    path.join(root, 'packaging/flatpak/space.taskyon.constellation.metainfo.xml'),
    'utf8',
  )
  for (const [relativePath, original] of originalJsonMetadata) {
    assert.equal(
      fs.readFileSync(path.join(root, relativePath), 'utf8'),
      original.replace(`"version": "${currentVersion}"`, `"version": "${targetVersion}"`),
      `${relativePath} must preserve formatting when its version changes`,
    )
  }
  assert.equal(packageJson.version, targetVersion)
  assert.equal(tauri.version, targetVersion)
  assert.match(cargo, new RegExp(`^version = "${targetVersion}"$`, 'm'))
  assert.match(pluginCargo, new RegExp(`^version = "${targetVersion}"$`, 'm'))
  assert.match(cargoLock, new RegExp(`name = "constellation"\\nversion = "${targetVersion}"`))
  assert.match(
    cargoLock,
    new RegExp(`name = "tauri-plugin-constellation-android"\\nversion = "${targetVersion}"`),
  )
  assert.match(
    metainfo,
    new RegExp(`<release version="${targetVersion}" date="\\d{4}-\\d{2}-\\d{2}" />`),
  )
  assert.ok(metainfo.includes(`<release version="${currentVersion}" date="`))
  assert.match(metainfo, /<release version="0\.0\.9" date="2026-01-01" \/>/)
  assert.ok(
    metainfo.indexOf(`<release version="${targetVersion}"`) <
      metainfo.indexOf(`<release version="${currentVersion}"`),
  )
  assert.equal(git(root, 'cat-file', '-t', `refs/tags/v${targetVersion}`), 'tag')
  assert.equal(git(root, 'log', '-1', '--format=%s'), `chore: prepare release v${targetVersion}`)
  assert.equal(git(root, 'status', '--porcelain'), '')
})

test('release refuses a dirty checkout before touching release metadata', (context) => {
  const root = makeReleaseRepository(context)
  const targetVersion = nextPatchVersion(root)
  fs.writeFileSync(path.join(root, 'untracked-review-note.txt'), 'synthetic fixture')
  const packageBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  const result = runRelease(root, targetVersion, '--yes')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /commit or remove all changes/i)
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), packageBefore)
  assert.equal(git(root, 'tag', '--list', `v${targetVersion}`), '')
})

test('release can tag the current version without changing metadata or creating a commit', (context) => {
  const root = makeReleaseRepository(context)
  const currentVersion = applicationVersion(root)
  git(root, 'tag', '--annotate', `v${currentVersion}-test.8`, '--message', 'Synthetic test release')
  const headBefore = git(root, 'rev-parse', 'HEAD')
  const before = versionFiles.map((relativePath) =>
    fs.readFileSync(path.join(root, relativePath), 'utf8'),
  )
  const preview = runRelease(root, currentVersion, '--dry-run')
  assert.equal(preview.status, 0, preview.stderr)
  assert.ok(preview.stdout.includes('at the current commit; metadata is unchanged'))
  assert.equal(git(root, 'tag', '--list', `v${currentVersion}`), '')

  const result = runRelease(root, currentVersion, '--yes')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`Current version tag created locally: v${currentVersion}`))
  assert.ok(result.stdout.includes(`git push origin main v${currentVersion}`))
  assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(git(root, 'rev-parse', `v${currentVersion}^{}`), headBefore)
  assert.equal(git(root, 'cat-file', '-t', `refs/tags/v${currentVersion}`), 'tag')
  assert.deepEqual(
    versionFiles.map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')),
    before,
  )
  assert.equal(git(root, 'status', '--porcelain'), '')
})

test('release refuses to downgrade the application version', (context) => {
  const root = makeReleaseRepository(context)
  const packageBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  const result = runRelease(root, '0.0.9', '--yes')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must not be older than the current version/i)
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), packageBefore)
  assert.equal(git(root, 'tag', '--list', 'v0.0.9'), '')
})

test('release refuses an equivalent SemVer with different build metadata', (context) => {
  const root = makeReleaseRepository(context)
  const currentVersion = applicationVersion(root)
  const equivalentVersion = `${currentVersion}+fixture`
  const result = runRelease(root, equivalentVersion, '--yes')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /same semantic version precedence/i)
  assert.equal(git(root, 'tag', '--list', `v${equivalentVersion}`), '')
})
