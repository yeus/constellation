import assert from 'node:assert/strict'
import test from 'node:test'

import { parseStandbySoakMinutes } from './android-standby-soak.mjs'

test('overnight duration is explicit, finite and bounded', () => {
  assert.equal(parseStandbySoakMinutes([]), null)
  assert.equal(parseStandbySoakMinutes(['--standby-soak-minutes=480']), 480)
  assert.equal(parseStandbySoakMinutes(['--standby-soak-minutes=0.1']), 0.1)
  for (const input of ['0', '-1', 'NaN', 'Infinity', '1441', '', '5minutes']) {
    assert.throws(() => parseStandbySoakMinutes([`--standby-soak-minutes=${input}`]), /duration/i)
  }
  assert.throws(() => parseStandbySoakMinutes(['--standby-soak-minutes', '480']), /duration/i)
  assert.throws(
    () => parseStandbySoakMinutes(['--standby-soak-minutes=1', '--standby-soak-minutes=2']),
    /only once/i,
  )
})
