import assert from 'node:assert/strict'
import test from 'node:test'
import { EmulatorCleanupError, runAcceptanceMatrix } from './android-acceptance-matrix.mjs'

test('runs independent scenarios sequentially and retains every failure', async () => {
  const events = []
  const reports = []
  const scenarios = ['modern', 'legacy', 'power'].map((name) => ({
    name,
    async run() {
      events.push(name)
      if (name === 'legacy') throw new Error('fixture failure')
    },
  }))
  await assert.rejects(
    runAcceptanceMatrix(scenarios, (line) => reports.push(line)),
    /1\/3.*failed.*legacy/,
  )
  assert.deepEqual(events, ['modern', 'legacy', 'power'])
  assert.deepEqual(
    reports.filter((line) => /PASS|FAIL/.test(line)),
    ['[Android matrix] PASS modern', '[Android matrix] FAIL legacy', '[Android matrix] PASS power'],
  )
  assert.equal(
    reports.some((line) => line.includes('fixture failure')),
    false,
  )
})

test('refuses to start another emulator when owned emulator cleanup failed', async () => {
  const failure = new EmulatorCleanupError('cleanup failed')
  await assert.rejects(
    runAcceptanceMatrix(
      [
        {
          name: 'first',
          run: async () => {
            throw failure
          },
        },
        {
          name: 'second',
          run: async () => {
            assert.fail('must not run')
          },
        },
      ],
      () => {},
    ),
    (error) => error === failure,
  )
})

test('reports a passing matrix only after every case completes', async () => {
  const reports = []
  await runAcceptanceMatrix([{ name: 'modern', run: async () => {} }], (line) => reports.push(line))
  assert.equal(reports.at(-1), '[Android matrix] 1/1 passed.')
})
