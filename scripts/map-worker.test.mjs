import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('loads Android compatibility before the bundled MapLibre 6 ESM worker', () => {
  const source = fs.readFileSync('src/map/pmtiles.ts', 'utf8')
  assert.match(source, /maplibre-gl-worker\.mjs\?worker&url/)
  assert.match(source, /setWorkerUrl\(workerBootstrapUrl\)/)
  const compatibilityImport = source.indexOf('import ${JSON.stringify(compatibilityUrl)};')
  const workerImport = source.indexOf('import ${JSON.stringify(compiledWorkerUrl)};')
  assert.ok(
    compatibilityImport >= 0 && workerImport > compatibilityImport,
    'worker compatibility modules must load before MapLibre starts',
  )
  assert.doesNotMatch(source, /maplibre-gl-csp-worker|importScripts/)
})
