import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const scopedDirectories = ['src', 'scripts', 'tests']
const sourceExtensions = new Set(['.ts', '.vue', '.mjs'])
const supportedTaskyonPackages = new Set(['@taskyon/protocol', '@taskyon/p2p-core'])

const sourceFiles = (directory) =>
  fs
    .readdirSync(path.join(repositoryRoot, directory), { recursive: true })
    .filter((entry) => sourceExtensions.has(path.extname(entry)))
    .map((entry) => path.join(directory, entry))

const importedSpecifiers = (contents) =>
  [...contents.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])

test('application code imports Taskyon packages only by their published names', () => {
  for (const directory of scopedDirectories) {
    for (const file of sourceFiles(directory)) {
      const contents = fs.readFileSync(path.join(repositoryRoot, file), 'utf8')
      for (const specifier of importedSpecifiers(contents)) {
        if (!specifier.startsWith('@taskyon/')) continue
        const packageName = specifier.split('/').slice(0, 2).join('/')
        assert.ok(
          supportedTaskyonPackages.has(packageName),
          `${file} imports unsupported Taskyon package ${specifier}`,
        )
      }
    }
  }
})

test('application code does not import sibling workspaces or build artifacts', () => {
  const forbidden = [
    /(^|\/)\.\.\/(frontend|taskyon)(\/|$)/,
    /^\/workspace\//,
    /(^|\/)vendor\/taskyon\/(?:p2p-core|protocol)\//,
  ]
  for (const directory of scopedDirectories) {
    for (const file of sourceFiles(directory)) {
      const contents = fs.readFileSync(path.join(repositoryRoot, file), 'utf8')
      for (const specifier of importedSpecifiers(contents)) {
        for (const pattern of forbidden) {
          assert.ok(!pattern.test(specifier), `${file} imports forbidden path ${specifier}`)
        }
        assert.ok(
          !(
            specifier.startsWith('.') && /(^|\/)(dist|dist-background|dist-tauri)\//.test(specifier)
          ),
          `${file} imports a repository build artifact ${specifier}`,
        )
      }
    }
  }
})

test('vendored Taskyon snapshots record their upstream provenance', () => {
  const upstream = fs.readFileSync(path.join(repositoryRoot, 'vendor/taskyon/UPSTREAM.md'), 'utf8')
  assert.match(upstream, /Source repository: Taskyon `frontend`/)
  assert.match(upstream, /Base revision: `[0-9a-f]{40}`/)
  assert.match(upstream, /Snapshot date: \d{4}-\d{2}-\d{2}/)

  for (const packageDirectory of ['p2p-core', 'protocol']) {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'vendor/taskyon', packageDirectory, 'package.json'),
        'utf8',
      ),
    )
    assert.equal(manifest.name, `@taskyon/${packageDirectory}`)
    assert.ok(manifest.license)
  }
})
