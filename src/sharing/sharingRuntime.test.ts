import assert from 'node:assert/strict'
import test from 'node:test'

import { rememberRedeemedNonce } from './sharingRuntime.ts'

test('bounds remembered redemption nonces and preserves recent entries', () => {
  const nonces = new Set<string>()

  rememberRedeemedNonce(nonces, 'first', 2)
  rememberRedeemedNonce(nonces, 'second', 2)
  rememberRedeemedNonce(nonces, 'third', 2)

  assert.deepEqual([...nonces], ['second', 'third'])
})
