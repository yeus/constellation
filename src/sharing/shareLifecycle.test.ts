import assert from 'node:assert/strict'
import test from 'node:test'

import { END_NOTICE_RETENTION_MS, retainedEndNotifications } from './shareLifecycle.ts'

test('retains ended-link notices for seven days with a bounded number of endpoints', () => {
  const records = Array.from({ length: 40 }, (_, index) => ({ endedAt: index + 1 }))
  assert.equal(END_NOTICE_RETENTION_MS, 7 * 24 * 60 * 60 * 1000)
  const retained = retainedEndNotifications(records, END_NOTICE_RETENTION_MS + 5)
  assert.equal(retained.length, 32)
  assert.equal(retained[0]?.endedAt, 40)
  assert.equal(retained.at(-1)?.endedAt, 9)
  assert.deepEqual(retainedEndNotifications(records, END_NOTICE_RETENTION_MS + 40), [])
})
