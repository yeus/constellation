import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldSignalIdleAfterShareUpdate } from './backgroundRuntimePolicy.ts'

test('signals service idle only when the final active share disappears', () => {
  assert.equal(shouldSignalIdleAfterShareUpdate(0, 0), false)
  assert.equal(shouldSignalIdleAfterShareUpdate(0, 1), false)
  assert.equal(shouldSignalIdleAfterShareUpdate(2, 1), false)
  assert.equal(shouldSignalIdleAfterShareUpdate(1, 0), true)
})
