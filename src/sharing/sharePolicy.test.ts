import assert from 'node:assert/strict'
import test from 'node:test'

import { backgroundSharePolicy, sharePauseReason } from './sharePolicy.ts'

test('pauses only background links that opted into metered pausing', () => {
  assert.equal(
    sharePauseReason({ publication: 'background', network: 'pause-when-metered' }, 'metered'),
    'metered',
  )
  assert.equal(
    sharePauseReason({ publication: 'background', network: 'pause-when-metered' }, 'data-saver'),
    'data-saver',
  )
  assert.equal(
    sharePauseReason({ publication: 'background', network: 'always' }, 'metered'),
    undefined,
  )
  assert.equal(
    sharePauseReason({ publication: 'foreground', network: 'pause-when-metered' }, 'metered'),
    undefined,
  )
  assert.equal(
    sharePauseReason({ publication: 'background', network: 'pause-when-metered' }, undefined),
    undefined,
  )
})

test('fails closed until the initial network restriction is known', () => {
  assert.equal(
    sharePauseReason({ publication: 'background', network: 'pause-when-metered' }, 'unknown'),
    'unknown',
  )
  assert.equal(
    sharePauseReason({ publication: 'background', network: 'always' }, 'unknown'),
    undefined,
  )
  assert.equal(
    sharePauseReason({ publication: 'foreground', network: 'pause-when-metered' }, 'unknown'),
    undefined,
  )
})

test('keeps background policy off foreground-only shares', () => {
  assert.deepEqual(backgroundSharePolicy('background', 'saver', 'pause-when-metered'), {
    battery: 'saver',
    network: 'pause-when-metered',
  })
  assert.deepEqual(backgroundSharePolicy('foreground', 'saver', 'pause-when-metered'), {
    battery: 'balanced',
    network: 'always',
  })
})
