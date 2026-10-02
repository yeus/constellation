import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

const familyFor = (license) => {
  if (!license || /UNLICENSED|PROPRIETARY|SEE LICENSE/i.test(license)) return 'unknown'
  if (/MPL/i.test(license)) return 'weak-copyleft'
  if (/A?GPL/i.test(license)) return 'copyleft'
  return 'permissive'
}

const combine = (families) => {
  if (families.includes('unknown')) return 'unknown'
  if (families.includes('copyleft')) return 'copyleft'
  if (families.includes('weak-copyleft')) return 'weak-copyleft'
  return 'permissive'
}

export const classifyLicense = (license) => {
  if (!license) return 'unknown'
  const alternatives = license.split(/\s+OR\s+/i).map((alternative) => {
    const requirements = alternative.split(/\s+AND\s+/i).map((part) => familyFor(part.trim()))
    return combine(requirements)
  })
  if (alternatives.includes('permissive')) return 'permissive'
  return combine(alternatives)
}

const installedManifest = (name, fromDirectory, root) => {
  let directory = fromDirectory
  while (directory.startsWith(root)) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'), 'package.json')
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

export const javascriptInventory = (root = process.cwd()) => {
  const rootManifest = readJson(path.join(root, 'package.json'))
  const found = new Map()
  const missing = new Map()
  const visit = (name, fromDirectory, requestedBy, optional = false) => {
    const manifestPath = installedManifest(name, fromDirectory, root)
    if (!manifestPath) {
      if (!optional && !missing.has(name)) missing.set(name, requestedBy)
      return
    }
    if (found.has(manifestPath)) return
    const manifest = readJson(manifestPath)
    const packageName = manifest.name ?? name
    const version = manifest.version ?? ''
    found.set(manifestPath, {
      name: packageName,
      version,
      license: manifest.license ?? null,
      family: classifyLicense(manifest.license),
      path: manifestPath,
    })
    const manifestDirectory = path.dirname(manifestPath)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      visit(dependency, manifestDirectory, `${packageName}@${version}`)
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      visit(dependency, manifestDirectory, `${packageName}@${version}`, true)
    }
  }
  for (const dependency of Object.keys(rootManifest.dependencies ?? {})) {
    visit(dependency, root, 'constellation')
  }
  const packages = [...found.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.path.localeCompare(right.path),
  )
  return {
    packages,
    missing: [...missing].map(([name, requestedBy]) => ({ name, requestedBy })),
  }
}

export const cargoInventory = (root = process.cwd()) => {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--manifest-path',
        path.join(root, 'src-tauri/Cargo.toml'),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  )
  const workspaceMembers = new Set(metadata.workspace_members)
  return metadata.packages
    .filter((pkg) => !workspaceMembers.has(pkg.id))
    .map((pkg) => {
      const license = pkg.license ?? (pkg.license_file ? `file:${pkg.license_file}` : null)
      return {
        name: pkg.name,
        version: pkg.version,
        license,
        family: classifyLicense(pkg.license),
      }
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    )
}

const summarize = (label, packages) => {
  const families = new Map()
  for (const pkg of packages) {
    families.set(pkg.family, (families.get(pkg.family) ?? 0) + 1)
  }
  console.log(`${label}: ${packages.length} packages`)
  for (const [family, count] of [...families].sort()) console.log(`  ${family}: ${count}`)
  for (const pkg of packages.filter((entry) => entry.family !== 'permissive')) {
    console.log(
      `  ${pkg.family}: ${pkg.name}@${pkg.version} (${pkg.license ?? 'no license field'})`,
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { packages: javascript, missing } = javascriptInventory()
  summarize('JavaScript production dependencies', javascript)
  if (missing.length > 0) {
    console.error(`${missing.length} JavaScript dependencies could not be resolved:`)
    for (const entry of missing) {
      console.error(`  ${entry.name} (required by ${entry.requestedBy})`)
    }
    process.exitCode = 1
  }
  let cargo = []
  try {
    cargo = cargoInventory()
    summarize('Cargo dependencies', cargo)
  } catch (error) {
    console.error(`Cargo inventory unavailable: ${error instanceof Error ? error.message : error}`)
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ javascript, cargo, missing }, null, 2))
  }
  const unknown = [...javascript, ...cargo].filter((pkg) => pkg.family === 'unknown')
  if (unknown.length > 0) {
    console.error(`${unknown.length} packages need license review.`)
    process.exitCode = 1
  }
}
