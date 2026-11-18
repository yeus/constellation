import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePowerJournal, powerMatrixCases, runPowerMatrixCase } from './android-power-matrix.mjs'

test('power snapshots are parsed without exporting unrelated private journal events', () => {
  const journal = [
    '1794500000000 location.fix source=android',
    '1794500001000 service.power.snapshot pct=80;charge=false;plug=false',
    '1794500002000 service.power.changed cause=screen-off;pct=5;charge=false',
    '1794500003000 service.power.monitor status=registered',
  ].join('\n')
  assert.deepEqual(parsePowerJournal(journal), [
    { event: 'service.power.snapshot', details: 'pct=80;charge=false;plug=false' },
    { event: 'service.power.changed', details: 'cause=screen-off;pct=5;charge=false' },
    { event: 'service.power.monitor', details: 'status=registered' },
  ])
})

test('every simulated system state restores its own overrides', () => {
  for (const scenario of powerMatrixCases) {
    assert.ok(scenario.name)
    assert.ok(scenario.apply.length > 0, scenario.name)
    assert.ok(scenario.restore.length > 0, scenario.name)
    assert.ok(scenario.check, scenario.name)
  }
  for (const name of ['battery-saver', 'doze']) {
    const scenario = powerMatrixCases.find((candidate) => candidate.name === name)
    assert.ok(
      scenario.apply.some((command) => command.join(' ') === 'dumpsys battery set status 3'),
    )
    assert.ok(scenario.restore.some((command) => command.join(' ') === 'dumpsys battery reset'))
  }
  const names = powerMatrixCases.map((scenario) => scenario.name)
  for (const name of [
    'unplugged',
    'low-battery',
    'charging',
    'battery-saver',
    'doze',
    'saver-and-doze',
    'data-saver',
    'data-saver-and-doze',
    'dnd',
    'app-standby',
    'background-restriction',
  ])
    assert.ok(names.includes(name), name)
})

test('power matrix accepts observed battery saver state, never merely an ADB command', () => {
  const saver = powerMatrixCases.find(({ name }) => name === 'battery-saver')
  const combined = powerMatrixCases.find(({ name }) => name === 'saver-and-doze')
  const events = (details) => [{ event: 'service.power.changed', details }]
  assert.equal(saver.check({ events: events('cause=screen-on;saver=false') }), false)
  assert.equal(saver.check({ events: events('cause=screen-on;saver=true') }), true)
  assert.equal(combined.check({ events: events('cause=doze;saver=false') }), false)
  assert.equal(combined.check({ events: events('cause=doze;saver=true') }), true)
})

test('Battery Saver activation waits until unplugged state is visible to Android', async () => {
  const scenario = powerMatrixCases.find(({ name }) => name === 'battery-saver')
  const commands = []
  let battery = 'AC powered: true\n  status: 2'
  await runPowerMatrixCase(scenario, {
    shell: (...args) => {
      commands.push(args.join(' '))
      if (args.join(' ') === 'dumpsys battery') return battery
      return ''
    },
    readPowerEvents: () => [
      { event: 'service.power.snapshot', details: 'saver=false' },
      ...(commands.includes('cmd power set-mode 1')
        ? [{ event: 'service.power.changed', details: 'saver=true' }]
        : []),
    ],
    refreshSnapshot: () => {},
    waitFor: async (predicate, _label, timeout) => {
      assert.equal(timeout >= 15_000, true)
      if (!predicate()) battery = 'AC powered: false\n  status: 3'
      assert.equal(predicate(), true)
    },
  })
  const afterBatteryQuery = commands.findIndex((command) => command === 'dumpsys battery')
  const saverCommand = commands.findIndex((command) => command === 'cmd power set-mode 1')
  assert.ok(saverCommand > afterBatteryQuery)
  assert.ok(commands.includes('cmd power set-mode 0'))
})

test('a failed assertion still restores a simulated power condition', async () => {
  const commands = []
  await assert.rejects(
    runPowerMatrixCase(
      {
        name: 'intentional-failure',
        apply: [['cmd', 'power', 'set-mode', '1']],
        restore: [['cmd', 'power', 'set-mode', '0']],
        check: () => false,
      },
      {
        shell: (...args) => {
          commands.push(args)
          return ''
        },
        readPowerEvents: () => [],
        refreshSnapshot: () => {},
        waitFor: async (check) => {
          if (!check()) throw new Error('not observed')
        },
      },
    ),
    /not observed/,
  )
  assert.deepEqual(commands, [
    ['cmd', 'power', 'set-mode', '1'],
    ['cmd', 'power', 'set-mode', '0'],
  ])
})

test('required cleanup failures fail the matrix without skipping remaining restoration', async () => {
  const commands = []
  await assert.rejects(
    runPowerMatrixCase(
      {
        name: 'cleanup-failure',
        apply: [['cmd', 'power', 'set-mode', '1']],
        restore: [
          ['cmd', 'power', 'set-mode', '0'],
          ['dumpsys', 'battery', 'reset'],
        ],
        check: () => true,
      },
      {
        shell: (...args) => {
          commands.push(args)
          if (args.join(' ') === 'cmd power set-mode 0') throw new Error('cleanup failed')
          return ''
        },
        readPowerEvents: () => [],
        refreshSnapshot: () => {},
        waitFor: async () => {},
      },
    ),
    /cleanup failed/,
  )
  assert.deepEqual(commands.at(-1), ['dumpsys', 'battery', 'reset'])
})

test('unsupported optional controls remain visibly skipped, never counted as passed', async () => {
  const result = await runPowerMatrixCase(
    {
      name: 'optional-control',
      apply: [['cmd', 'power', 'set-low-power-standby-active', 'true']],
      restore: [['cmd', 'power', 'set-low-power-standby-active', 'false']],
      optional: true,
      check: () => true,
    },
    {
      shell: () => {
        throw new Error('Unknown command')
      },
      readPowerEvents: () => [],
      refreshSnapshot: () => {},
      waitFor: async () => {},
    },
  )
  assert.equal(result.status, 'unsupported')
})
