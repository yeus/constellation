// Emulator-only power acceptance. A foreground service may keep an app in an
// active standby bucket; never treat an ADB command succeeding as proof that
// the OS applied the requested policy.
const packageName = 'space.taskyon.constellation'
const hasPowerState = (events, fields) =>
  events.some(({ details }) => fields.every((field) => details.includes(field)))
const state =
  (...fields) =>
  ({ events }) =>
    hasPowerState(events, fields)

export const parsePowerJournal = (journal) =>
  journal.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^\d+ (service\.power\.(?:snapshot|changed)|service\.heartbeat)(?: (.*))?$/,
    )
    return match ? [{ event: match[1], details: match[2] ?? '' }] : []
  })

export const powerMatrixCases = [
  {
    name: 'unplugged',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'level', '80'],
    ],
    restore: [['dumpsys', 'battery', 'reset']],
    check: state('batteryPct=80', 'plugged=false'),
  },
  {
    name: 'low-battery',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'level', '5'],
    ],
    restore: [['dumpsys', 'battery', 'reset']],
    check: state('batteryPct=5', 'plugged=false'),
  },
  {
    name: 'charging',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'ac', '1'],
      ['dumpsys', 'battery', 'set', 'status', '2'],
    ],
    restore: [['dumpsys', 'battery', 'reset']],
    check: state('charging=true', 'plugged=true'),
  },
  {
    name: 'battery-saver',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'status', '3'],
      ['dumpsys', 'battery', 'set', 'level', '30'],
      ['cmd', 'power', 'set-mode', '1'],
    ],
    restore: [
      ['cmd', 'power', 'set-mode', '0'],
      ['dumpsys', 'battery', 'reset'],
    ],
    check: state('cause=battery-saver'),
  },
  {
    name: 'doze',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'status', '3'],
      ['input', 'keyevent', 'KEYCODE_SLEEP'],
      ['dumpsys', 'deviceidle', 'force-idle'],
    ],
    restore: [
      ['dumpsys', 'deviceidle', 'unforce'],
      ['input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['dumpsys', 'battery', 'reset'],
    ],
    check: state('cause=doze'),
    refresh: false,
  },
  {
    name: 'saver-and-doze',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'status', '3'],
      ['dumpsys', 'battery', 'set', 'level', '30'],
      ['cmd', 'power', 'set-mode', '1'],
      ['input', 'keyevent', 'KEYCODE_SLEEP'],
      ['dumpsys', 'deviceidle', 'force-idle'],
    ],
    restore: [
      ['dumpsys', 'deviceidle', 'unforce'],
      ['input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['cmd', 'power', 'set-mode', '0'],
      ['dumpsys', 'battery', 'reset'],
    ],
    check: ({ events }) =>
      hasPowerState(events, ['cause=battery-saver']) && hasPowerState(events, ['cause=doze']),
    refresh: false,
  },
  {
    name: 'data-saver',
    apply: [['cmd', 'netpolicy', 'set', 'restrict-background', 'true']],
    restore: [['cmd', 'netpolicy', 'set', 'restrict-background', 'false']],
    // Foreground services may be exempt from the device-wide restriction.
    check: ({ events }) =>
      (hasPowerState(events, ['cause=data-saver']) &&
        hasPowerState(events, ['dataSaver=enabled'])) ||
      hasPowerState(events, ['cause=data-saver', 'dataSaver=exempt']),
  },
  {
    name: 'data-saver-and-doze',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'status', '3'],
      ['cmd', 'netpolicy', 'set', 'restrict-background', 'true'],
      ['input', 'keyevent', 'KEYCODE_SLEEP'],
      ['dumpsys', 'deviceidle', 'force-idle'],
    ],
    restore: [
      ['dumpsys', 'deviceidle', 'unforce'],
      ['input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['cmd', 'netpolicy', 'set', 'restrict-background', 'false'],
      ['dumpsys', 'battery', 'reset'],
    ],
    check: ({ events }) =>
      hasPowerState(events, ['cause=data-saver']) && hasPowerState(events, ['cause=doze']),
    refresh: false,
  },
  {
    name: 'dnd',
    apply: [['cmd', 'notification', 'set_dnd', 'priority']],
    restore: [['cmd', 'notification', 'set_dnd', 'off']],
    check: state('dnd=priority'),
    optional: true,
  },
  {
    name: 'app-standby',
    apply: [['am', 'set-standby-bucket', packageName, 'rare']],
    restore: [['am', 'set-standby-bucket', packageName, 'active']],
    // A foreground service may force active; report that as not-applied, not passed.
    check: ({ shell }) => /^(40|rare)$/.test(shell('am', 'get-standby-bucket', packageName).trim()),
    optional: true,
  },
  {
    name: 'background-restriction',
    apply: [['cmd', 'appops', 'set', packageName, 'RUN_ANY_IN_BACKGROUND', 'ignore']],
    restore: [['cmd', 'appops', 'set', packageName, 'RUN_ANY_IN_BACKGROUND', 'allow']],
    check: ({ shell }) =>
      /RUN_ANY_IN_BACKGROUND:\s*ignore/.test(
        shell('cmd', 'appops', 'get', packageName, 'RUN_ANY_IN_BACKGROUND'),
      ),
  },
  {
    name: 'low-power-standby',
    apply: [['cmd', 'power', 'set-low-power-standby-active', 'true']],
    restore: [['cmd', 'power', 'set-low-power-standby-active', 'false']],
    check: state('lowPowerStandby=true'),
    optional: true,
  },
]

// Inject ADB and poller so the scenario/cleanup contract can be tested without Android.
// A skipped optional case is reported separately and never accepted as passed.
export const runPowerMatrixCase = async (
  scenario,
  { shell, readPowerEvents, refreshSnapshot, waitFor },
) => {
  const startCount = readPowerEvents().length
  let applied = false
  let outcome
  let scenarioError
  let cleanupError
  try {
    try {
      for (const command of scenario.apply) shell(...command)
      applied = true
    } catch (error) {
      if (!scenario.optional) throw error
      outcome = { name: scenario.name, status: 'unsupported', reason: String(error).slice(0, 120) }
    }
    if (!outcome) {
      if (scenario.refresh !== false) await refreshSnapshot()
      try {
        await waitFor(
          () => scenario.check({ shell, events: readPowerEvents().slice(startCount) }),
          `power-state evidence: ${scenario.name}`,
          15_000,
        )
      } catch (error) {
        if (!scenario.optional) throw error
        outcome = {
          name: scenario.name,
          status: 'not-applied',
          reason: String(error).slice(0, 120),
        }
      }
    }
    outcome ??= { name: scenario.name, status: 'passed' }
  } catch (error) {
    scenarioError = error
  } finally {
    // Attempt every cleanup command; never silently pass with a broken reset.
    for (const command of scenario.restore) {
      try {
        shell(...command)
      } catch (error) {
        if ((applied || !scenario.optional) && !cleanupError) cleanupError = error
      }
    }
  }
  if (scenarioError) throw scenarioError
  if (cleanupError) throw cleanupError
  return outcome
}
