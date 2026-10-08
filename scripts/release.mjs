import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const releaseMetadataPaths = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/plugins/constellation-android/Cargo.toml',
  'packaging/flatpak/space.taskyon.constellation.metainfo.xml',
]
const cargoPackageNames = ['constellation', 'tauri-plugin-constellation-android']
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const absolutePath = (repositoryRoot, relativePath) => path.join(repositoryRoot, relativePath)

const readJson = (repositoryRoot, relativePath) =>
  JSON.parse(fs.readFileSync(absolutePath(repositoryRoot, relativePath), 'utf8'))

const readText = (repositoryRoot, relativePath) =>
  fs.readFileSync(absolutePath(repositoryRoot, relativePath), 'utf8')

const writeText = (repositoryRoot, relativePath, content) =>
  fs.writeFileSync(absolutePath(repositoryRoot, relativePath), content, 'utf8')

const updateJsonVersion = (repositoryRoot, relativePath, currentVersion, version) => {
  const source = readText(repositoryRoot, relativePath)
  const versionLine = /^([ \t]{2}"version"[ \t]*:[ \t]*)"([^"]+)"(?=,?[ \t]*$)/m
  const match = source.match(versionLine)
  if (!match || match[2] !== currentVersion) {
    throw new Error(`${relativePath} has no expected top-level version ${currentVersion}.`)
  }
  return source.replace(versionLine, (_match, prefix) => `${prefix}${JSON.stringify(version)}`)
}

const gitOutput = (repositoryRoot, args) => {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}

const parseSemver = (version) => {
  const match = semverPattern.exec(version)
  if (!match)
    throw new Error(`Invalid version: ${version}. Use semantic versioning, such as 0.2.0.`)
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') ?? [] }
}

const comparePrerelease = (left, right) => {
  const count = Math.min(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left[index]
    const rightIdentifier = right[index]
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/.test(leftIdentifier)
    const rightNumeric = /^\d+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric)
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return Math.sign(left.length - right.length)
}

const compareSemver = (leftVersion, rightVersion) => {
  const left = parseSemver(leftVersion)
  const right = parseSemver(rightVersion)
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  if (!left.prerelease.length) return right.prerelease.length ? 1 : 0
  if (!right.prerelease.length) return -1
  return comparePrerelease(left.prerelease, right.prerelease)
}

const cargoSections = (source) => source.split(/(?=^\[[^\r\n]+\]\r?$)/m)

const cargoPackageSection = (source, relativePath, expectedName) => {
  const section = cargoSections(source).find((part) => /^\[package\]\r?$/m.test(part))
  if (!section) throw new Error(`${relativePath} has no [package] section.`)
  const name = section.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const version = section.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  if (name !== expectedName || !version) {
    throw new Error(`${relativePath} does not declare package ${expectedName} and a version.`)
  }
  return { section, version }
}

const updateCargoManifest = (source, relativePath, packageName, currentVersion, version) => {
  const { section, version: foundVersion } = cargoPackageSection(source, relativePath, packageName)
  if (foundVersion !== currentVersion) {
    throw new Error(`${relativePath} has version ${foundVersion}, expected ${currentVersion}.`)
  }
  const updatedSection = section.replace(/^(version\s*=\s*)"[^"]+"(\s*)$/m, `$1"${version}"$2`)
  if (updatedSection === section) throw new Error(`Could not update ${relativePath}.`)
  return source.replace(section, updatedSection)
}

const cargoLockBlocks = (source) => source.split(/(?=^\[\[package\]\]\r?$)/m)

const cargoLockPackageVersion = (source, relativePath, packageName) => {
  const matches = cargoLockBlocks(source)
    .map((block) => ({
      name: block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1],
      version: block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1],
    }))
    .filter((entry) => entry.name === packageName)
  if (matches.length !== 1 || !matches[0].version) {
    throw new Error(`${relativePath} must contain exactly one ${packageName} package.`)
  }
  return matches[0].version
}

const updateCargoLock = (source, currentVersion, version) => {
  const found = new Set()
  const updated = cargoLockBlocks(source).map((block) => {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1]
    if (!cargoPackageNames.includes(name)) return block
    if (found.has(name)) throw new Error(`Cargo.lock contains duplicate package ${name}.`)
    found.add(name)
    const current = block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
    if (current !== currentVersion) {
      throw new Error(`Cargo.lock ${name} has version ${current}, expected ${currentVersion}.`)
    }
    return block.replace(/^(version\s*=\s*)"[^"]+"(\s*)$/m, `$1"${version}"$2`)
  })
  if (found.size !== cargoPackageNames.length) {
    throw new Error('Cargo.lock is missing one or more Constellation packages.')
  }
  return updated.join('')
}

const appstreamReleaseData = (source, relativePath) => {
  const opening = source.indexOf('<releases>')
  const closing = source.indexOf('</releases>', opening)
  if (opening < 0 || closing < 0) throw new Error(`${relativePath} has no <releases> section.`)
  const openingLineEnd = source.indexOf('\n', opening)
  if (openingLineEnd < 0 || openingLineEnd >= closing) {
    throw new Error(`${relativePath} has a malformed <releases> section.`)
  }
  const bodyStart = openingLineEnd + 1
  const body = source.slice(bodyStart, closing)
  const releases = [
    ...body.matchAll(/^[ \t]*<release version="([^"]+)" date="([^"]+)" \/>\s*$/gm),
  ].map((match) => ({ version: match[1], date: match[2] }))
  if (!releases.length) throw new Error(`${relativePath} has no release entries.`)
  return { bodyStart, body, releases }
}

const updateAppstream = (source, relativePath, version, date) => {
  const { bodyStart, body, releases } = appstreamReleaseData(source, relativePath)
  if (releases.some((release) => release.version === version)) {
    throw new Error(`${relativePath} already contains release ${version}.`)
  }
  const indent = body.match(/^([ \t]*)<release /m)?.[1]
  if (indent === undefined) throw new Error(`${relativePath} has malformed release entries.`)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const entry = `${indent}<release version="${version}" date="${date}" />${newline}`
  return `${source.slice(0, bodyStart)}${entry}${source.slice(bodyStart)}`
}

const collectConsistencyErrors = (repositoryRoot) => {
  const expected = readJson(repositoryRoot, 'package.json').version
  const errors = []
  if (typeof expected !== 'string' || !semverPattern.test(expected)) {
    errors.push(`package.json has an invalid application version: ${expected}`)
    return { expected, errors }
  }

  const tauriVersion = readJson(repositoryRoot, 'src-tauri/tauri.conf.json').version
  if (tauriVersion !== expected) {
    errors.push(`src-tauri/tauri.conf.json has version ${tauriVersion}, expected ${expected}`)
  }
  for (const [relativePath, packageName] of [
    ['src-tauri/Cargo.toml', 'constellation'],
    ['src-tauri/plugins/constellation-android/Cargo.toml', 'tauri-plugin-constellation-android'],
  ]) {
    const { version } = cargoPackageSection(
      readText(repositoryRoot, relativePath),
      relativePath,
      packageName,
    )
    if (version !== expected)
      errors.push(`${relativePath} has version ${version}, expected ${expected}`)
  }

  const cargoLockPath = 'src-tauri/Cargo.lock'
  const cargoLock = readText(repositoryRoot, cargoLockPath)
  for (const packageName of cargoPackageNames) {
    const version = cargoLockPackageVersion(cargoLock, cargoLockPath, packageName)
    if (version !== expected)
      errors.push(`${cargoLockPath} ${packageName} has version ${version}, expected ${expected}`)
  }

  const metainfoPath = 'packaging/flatpak/space.taskyon.constellation.metainfo.xml'
  const releases = appstreamReleaseData(
    readText(repositoryRoot, metainfoPath),
    metainfoPath,
  ).releases
  if (releases[0].version !== expected) {
    errors.push(`${metainfoPath} latest release is ${releases[0].version}, expected ${expected}`)
  }
  const invalidDate = releases.find((release) => !/^\d{4}-\d{2}-\d{2}$/.test(release.date))
  if (invalidDate)
    errors.push(`${metainfoPath} has an invalid release date for ${invalidDate.version}`)
  const duplicateVersion = releases.find(
    (release, index) =>
      releases.findIndex((candidate) => candidate.version === release.version) !== index,
  )
  if (duplicateVersion)
    errors.push(`${metainfoPath} contains duplicate release ${duplicateVersion.version}`)
  return { expected, errors }
}

const assertConsistency = (repositoryRoot) => {
  const { expected, errors } = collectConsistencyErrors(repositoryRoot)
  if (errors.length) throw new Error(`Release metadata is inconsistent:\n- ${errors.join('\n- ')}`)
  console.log(`Release metadata is consistent at version ${expected}.`)
  return expected
}

const assertWorktreeClean = (repositoryRoot) => {
  const changes = gitOutput(repositoryRoot, ['status', '--porcelain', '--untracked-files=all'])
  if (changes)
    throw new Error(`Commit or remove all changes before preparing a release:\n${changes}`)
}

const assertTagAvailable = (repositoryRoot, version) => {
  const tag = `v${version}`
  if (gitOutput(repositoryRoot, ['tag', '--list', tag]).split('\n').includes(tag)) {
    throw new Error(`Git tag ${tag} already exists.`)
  }
}

const assertGitIdentity = (repositoryRoot) => {
  gitOutput(repositoryRoot, ['var', 'GIT_AUTHOR_IDENT'])
  gitOutput(repositoryRoot, ['var', 'GIT_COMMITTER_IDENT'])
}

const createReleaseUpdates = (repositoryRoot, currentVersion, version, date) => {
  return new Map([
    ['package.json', updateJsonVersion(repositoryRoot, 'package.json', currentVersion, version)],
    [
      'src-tauri/tauri.conf.json',
      updateJsonVersion(repositoryRoot, 'src-tauri/tauri.conf.json', currentVersion, version),
    ],
    [
      'src-tauri/Cargo.toml',
      updateCargoManifest(
        readText(repositoryRoot, 'src-tauri/Cargo.toml'),
        'src-tauri/Cargo.toml',
        'constellation',
        currentVersion,
        version,
      ),
    ],
    [
      'src-tauri/plugins/constellation-android/Cargo.toml',
      updateCargoManifest(
        readText(repositoryRoot, 'src-tauri/plugins/constellation-android/Cargo.toml'),
        'src-tauri/plugins/constellation-android/Cargo.toml',
        'tauri-plugin-constellation-android',
        currentVersion,
        version,
      ),
    ],
    [
      'src-tauri/Cargo.lock',
      updateCargoLock(readText(repositoryRoot, 'src-tauri/Cargo.lock'), currentVersion, version),
    ],
    [
      'packaging/flatpak/space.taskyon.constellation.metainfo.xml',
      updateAppstream(
        readText(repositoryRoot, 'packaging/flatpak/space.taskyon.constellation.metainfo.xml'),
        'packaging/flatpak/space.taskyon.constellation.metainfo.xml',
        version,
        date,
      ),
    ],
  ])
}

const applyReleaseUpdates = (repositoryRoot, updates) => {
  updates.forEach((content, relativePath) => writeText(repositoryRoot, relativePath, content))
}

const stageReleaseMetadata = (repositoryRoot) =>
  gitOutput(repositoryRoot, ['add', '--', ...releaseMetadataPaths])

const createReleaseTag = (repositoryRoot, version) => {
  const tag = `v${version}`
  gitOutput(repositoryRoot, ['tag', '--annotate', tag, '--message', `Release ${tag}`])
  return tag
}

const commitAndTagRelease = (repositoryRoot, version) => {
  const tag = `v${version}`
  gitOutput(repositoryRoot, ['commit', '-m', `chore: prepare release ${tag}`])
  return createReleaseTag(repositoryRoot, version)
}

const latestVersionTag = (repositoryRoot) =>
  gitOutput(repositoryRoot, ['tag', '--list', '--sort=-creatordate'])
    .split('\n')
    .find((tag) => semverPattern.test(tag.startsWith('v') ? tag.slice(1) : tag)) ?? 'none'

const promptForVersion = async (repositoryRoot) => {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(`Current application version: ${readJson(repositoryRoot, 'package.json').version}`)
    console.log(`Latest local version-like tag: ${latestVersionTag(repositoryRoot)}`)
    return (await terminal.question('New version (for example 0.2.0-rc.1): ')).trim()
  } finally {
    terminal.close()
  }
}

const confirmRelease = async (version) => {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (
      await terminal.question(`Prepare release ${version} and create local tag v${version}? [y/N] `)
    )
      .trim()
      .toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    terminal.close()
  }
}

const parseArguments = (args) => {
  const flags = new Set(['--check', '--dry-run', '--yes', '--help'])
  const options = { check: false, dryRun: false, yes: false, help: false, version: undefined }
  for (const argument of args) {
    if (flags.has(argument)) {
      const key = { '--check': 'check', '--dry-run': 'dryRun', '--yes': 'yes', '--help': 'help' }[
        argument
      ]
      if (options[key]) throw new Error(`Option ${argument} was provided more than once.`)
      options[key] = true
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown release option: ${argument}`)
    } else if (options.version) {
      throw new Error('Provide one version only. Use --help for usage.')
    } else {
      options.version = argument
    }
  }
  if (options.check && (options.version || options.dryRun || options.yes)) {
    throw new Error('--check cannot be combined with a version, --dry-run, or --yes.')
  }
  return options
}

const releasePushCommand = (repositoryRoot, tag) => {
  const branch = gitOutput(repositoryRoot, ['branch', '--show-current'])
  return branch ? `git push origin ${branch} ${tag}` : `git push origin ${tag}`
}

const validateReleaseVersion = (version, currentVersion) => {
  parseSemver(version)
  const comparison = compareSemver(version, currentVersion)
  if (comparison < 0) {
    throw new Error(
      `Version ${version} must not be older than the current version ${currentVersion}.`,
    )
  }
  if (comparison === 0 && version !== currentVersion) {
    throw new Error(
      `Version ${version} has the same semantic version precedence as the current version ${currentVersion}; use the exact current version or a higher version.`,
    )
  }
  return comparison === 0
}

const previewRelease = (version, currentVersion, isCurrentVersion) => {
  if (isCurrentVersion) {
    console.log(
      `Would create annotated tag v${version} at the current commit; metadata is unchanged.`,
    )
    return
  }
  console.log(`Would prepare release ${version} from ${currentVersion}.`)
  console.log(`Would update: ${releaseMetadataPaths.join(', ')}`)
}

const printReleasePushCommand = (repositoryRoot, tag, action) => {
  console.log(`Push the ${action} when ready:`)
  console.log(`  ${releasePushCommand(repositoryRoot, tag)}`)
}

const tagCurrentVersion = (repositoryRoot, version) => {
  const tag = createReleaseTag(repositoryRoot, version)
  console.log(`Current version tag created locally: ${tag}`)
  printReleasePushCommand(repositoryRoot, tag, 'release tag')
}

const prepareNewRelease = (repositoryRoot, currentVersion, version) => {
  const date = new Date().toISOString().slice(0, 10)
  const updates = createReleaseUpdates(repositoryRoot, currentVersion, version, date)
  applyReleaseUpdates(repositoryRoot, updates)
  assertConsistency(repositoryRoot)
  stageReleaseMetadata(repositoryRoot)
  const tag = commitAndTagRelease(repositoryRoot, version)
  console.log(`Release commit and tag created locally: ${tag}`)
  printReleasePushCommand(repositoryRoot, tag, 'release commit and tag')
}

const usage = () => {
  console.log('Usage: yarn release [version] [--dry-run] [--yes]')
  console.log('       yarn release --check')
}

const main = async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options = parseArguments(process.argv.slice(2))
  if (options.help) return usage()
  if (options.check) {
    assertConsistency(repositoryRoot)
    return
  }

  assertWorktreeClean(repositoryRoot)
  const currentVersion = assertConsistency(repositoryRoot)
  const version = options.version ?? (await promptForVersion(repositoryRoot))
  const isCurrentVersion = validateReleaseVersion(version, currentVersion)
  assertTagAvailable(repositoryRoot, version)
  if (options.dryRun) {
    previewRelease(version, currentVersion, isCurrentVersion)
    return
  }

  assertGitIdentity(repositoryRoot)
  if (!options.yes && !(await confirmRelease(version))) {
    console.log('Release preparation cancelled.')
    return
  }

  if (isCurrentVersion) {
    tagCurrentVersion(repositoryRoot, version)
    return
  }

  prepareNewRelease(repositoryRoot, currentVersion, version)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
