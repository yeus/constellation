import assert from 'node:assert/strict'
import test from 'node:test'

import { browserProcessEnvironment } from './browser-environment.mjs'

test('does not pass Nix library overrides to downloaded browsers', () => {
  const environment = browserProcessEnvironment({
    PATH: '/bin',
    LD_LIBRARY_PATH: '/nix/store/example',
  })

  assert.deepEqual(environment, { PATH: '/bin' })
})
