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
      /^\d+ (service\.power\.(?:snapshot|changed|monitor)|service\.heartbeat)(?: (.*))?$/,
    )
    return match ? [{ event: match[1], details: match[2] ?? '' }] : []
  })

// Android may still consider a freshly unplugged emulator to be charging.
// Wait for the battery service to observe discharging before enabling Saver.
const activateBatterySaver = async ({ shell, waitFor }) => {
  await waitFor(
    () => {
      const battery = shell('dumpsys', 'battery')
      return /AC powered:\s*false/.test(battery) && /status:\s*3/.test(battery)
    },
    'discharging before enabling Battery Saver',
    15_000,
  )
  shell('cmd', 'power', 'set-mode', '1')
}

export const powerMatrixCases = [
  {
    name: 'unplugged',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'level', '80'],
    ],
    restore: [['dumpsys', 'battery', 'reset']],
    check: state('pct=80', 'plug=false'),
  },
  {
    name: 'low-battery',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'level', '5'],
    ],
    restore: [['dumpsys', 'battery', 'reset']],
    check: state('pct=5', 'plug=false'),
  },
  {
    name: 'charging',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'ac', '1'],
      ['dumpsys', 'battery', 'set', 'status', '2'],
    ],
    restore: [['dumpsys', 'battery', 'reset']],
    check: state('charge=true', 'plug=true'),
  },
  {
    name: 'battery-saver',
    apply: [
      ['dumpsys', 'battery', 'unplug'],
      ['dumpsys', 'battery', 'set', 'status', '3'],
      ['dumpsys', 'battery', 'set', 'level', '30'],
    ],
    restore: [
      ['cmd', 'power', 'set-mode', '0'],
      ['dumpsys', 'battery', 'reset'],
    ],
    activate: activateBatterySaver,
    timeoutMs: 45_000,
    // Verify the actual OS state, not only delivery of a best-effort broadcast.
    check: state('saver=true'),
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
    ],
    restore: [
      ['dumpsys', 'deviceidle', 'unforce'],
      ['input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['cmd', 'power', 'set-mode', '0'],
      ['dumpsys', 'battery', 'reset'],
    ],
    activate: async (context) => {
      await activateBatterySaver(context)
      context.shell('input', 'keyevent', 'KEYCODE_SLEEP')
      context.shell('dumpsys', 'deviceidle', 'force-idle')
    },
    timeoutMs: 45_000,
    check: ({ events }) =>
      hasPowerState(events, ['saver=true']) && hasPowerState(events, ['cause=doze']),
    refresh: false,
  },
  {
    name: 'data-saver',
    apply: [['cmd', 'netpolicy', 'set', 'restrict-background', 'true']],
    restore: [['cmd', 'netpolicy', 'set', 'restrict-background', 'false']],
    // Foreground services may be exempt from the device-wide restriction.
    check: ({ events }) =>
      (hasPowerState(events, ['cause=data-saver']) && hasPowerState(events, ['data=enabled'])) ||
      hasPowerState(events, ['cause=data-saver', 'data=exempt']),
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
    check: state('lowStandby=true'),
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
      await scenario.activate?.({ shell, waitFor })
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
          scenario.timeoutMs ?? 15_000,
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
