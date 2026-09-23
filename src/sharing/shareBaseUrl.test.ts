import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveShareBaseUrl } from './shareBaseUrl.ts'

test('uses the configured public URL instead of a Tauri internal origin', () => {
  assert.equal(
    resolveShareBaseUrl(
      'https://constellation.taskyon.space/',
      new URL('http://tauri.localhost/map'),
    ),
    'https://constellation.taskyon.space/',
  )
})

test('falls back to the current web origin and path', () => {
  assert.equal(
    resolveShareBaseUrl(undefined, new URL('https://preview.invalid/map?q=1#old')),
    'https://preview.invalid/map',
  )
})
