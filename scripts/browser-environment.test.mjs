import assert from 'node:assert/strict'
import test from 'node:test'

import { browserProcessEnvironment } from './browser-environment.mjs'

test('does not pass Nix library overrides to downloaded browsers', () => {
  const environment = browserProcessEnvironment({
    PATH: '/bin',
    LD_LIBRARY_PATH: '/nix/store/example',
    DISPLAY: ':99',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/synthetic/host-auth',
  })

  assert.deepEqual(environment, { PATH: '/bin' })
})

test('uses only explicitly configured browser runtime libraries', () => {
  const original = {
    LD_LIBRARY_PATH: '/host/lib',
    CONSTELLATION_BROWSER_LIBRARY_PATH: '/browser/lib',
    DISPLAY: ':99',
  }
  assert.deepEqual(browserProcessEnvironment(original), {
    LD_LIBRARY_PATH: '/browser/lib',
    CONSTELLATION_BROWSER_LIBRARY_PATH: '/browser/lib',
  })
  assert.equal(original.LD_LIBRARY_PATH, '/host/lib')
  assert.equal(original.DISPLAY, ':99')
})

test('an empty browser library path does not restore host overrides', () => {
  assert.deepEqual(
    browserProcessEnvironment({
      LD_LIBRARY_PATH: '/host/lib',
      CONSTELLATION_BROWSER_LIBRARY_PATH: '',
    }),
    { CONSTELLATION_BROWSER_LIBRARY_PATH: '' },
  )
})
