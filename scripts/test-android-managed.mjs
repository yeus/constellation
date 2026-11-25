import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  androidAdbEnvironment,
  androidTool,
  create,
  emulatorArguments,
  emulatorLaunch,
  findManagedEmulatorSerial,
  parseAdbDevices,
  profile,
  requireProfileImage,
  removeInstalledTestPackage,
} from './android-emulator.mjs'
import {
  buildNetworkLocationFixture,
  networkFixtureAction,
  networkFixturePackage,
  networkFixtureReceiver,
} from './android-network-location-fixture.mjs'
import { androidApkCandidates, managedAndroidApkPath } from './copy-android-apk.mjs'
import { parseStandbySoakMinutes } from './android-standby-soak.mjs'
import { summarizeAndroidNativeCrash } from './android-test-privacy.mjs'

const packageName = 'space.taskyon.constellation'
const apk = managedAndroidApkPath(process.cwd())
const threeWayApk = managedAndroidApkPath(process.cwd(), true)
const localRelayAddress = '/ip4/127.0.0.1/tcp/9111/ws'

const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    stdio: 'inherit',
    ...options,
  })

const adbPath = androidTool('adb')
const adbEnvironment = androidAdbEnvironment()

// The ADB daemon is shared across emulator processes. Killing it here races
// with active debug sessions and makes unrelated test controls disconnect.
const ensureAdbServer = () => run(adbPath, ['start-server'], { env: adbEnvironment })

const adb = (args, options = {}, serial) =>
  execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: adbEnvironment,
    ...options,
  })

const wait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const devices = () => parseAdbDevices(adb(['devices', '-l'], { timeout: 10_000 }))

const waitForBoot = async (child, avdName, previousIdentities) => {
  const deadline = Date.now() + 180_000
  let onlineDevices = 0
  let newDevices = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${avdName} exited before booting (exitCode=${child.exitCode ?? 'none'}; signal=${child.signalCode ?? 'none'}).`,
      )
    }
    try {
      const available = devices().filter((device) => device.state === 'device')
      onlineDevices = available.length
      newDevices = available.filter((device) => !previousIdentities.has(device.identity)).length
      const serial = findManagedEmulatorSerial(
        available,
        previousIdentities,
        avdName,
        (candidate) => adb(['emu', 'avd', 'name'], { timeout: 3_000 }, candidate),
      )
      if (
        serial &&
        adb(['shell', 'getprop', 'sys.boot_completed'], { timeout: 10_000 }, serial).trim() === '1'
      ) {
        const packageService = adb(
          ['shell', 'cmd', 'package', 'list', 'packages', 'android'],
          { timeout: 10_000 },
          serial,
        )
        if (packageService.includes('package:android')) return serial
      }
    } catch {
      // ADB is expected to be unavailable briefly while the emulator starts.
    }
    await wait(1_000)
  }
  throw new Error(
    `${avdName} did not finish booting (online devices: ${onlineDevices}; newly discovered: ${newDevices}).`,
  )
}

const stopEmulator = async (child, serial) => {
  try {
    if (serial) adb(['emu', 'kill'], { timeout: 10_000 }, serial)
  } catch {
    // A failed test may already have stopped the emulator.
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const awaitExit = async (timeout) => {
    const deadline = Date.now() + timeout
    while (!exited() && Date.now() < deadline) await wait(250)
  }
  await awaitExit(15_000)
  if (!exited()) {
    child.kill('SIGTERM')
    await awaitExit(10_000)
  }
  if (!exited()) {
    child.kill('SIGKILL')
    await awaitExit(5_000)
  }
  if (!exited()) throw new Error('Owned emulator did not exit after shutdown.')
}

const uninstallIfPresent = (serial) =>
  removeInstalledTestPackage((args, options) => adb(args, options, serial), packageName)

const startProfile = async (selected, prepare, { uninstall = true } = {}) => {
  const profileEnvironment = selected.sdkRoot
    ? {
        ...adbEnvironment,
        ANDROID_HOME: selected.sdkRoot,
        ANDROID_SDK_ROOT: selected.sdkRoot,
      }
    : adbEnvironment
  requireProfileImage(selected, profileEnvironment)
  create(selected, profileEnvironment)
  const previousIdentities = new Set(devices().map((device) => device.identity))
  const launch = emulatorLaunch(profileEnvironment, adbEnvironment)
  const child = spawn(
    launch.executable,
    emulatorArguments(selected, ['-no-window', '-no-boot-anim']),
    {
      stdio: 'ignore',
      env: launch.environment,
    },
  )
  let serial
  try {
    serial = await waitForBoot(child, selected.avdName, previousIdentities)
    adb(['shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1'], {}, serial)
    if (uninstall) uninstallIfPresent(serial)
    await prepare?.(serial)
    return { child, serial, profileEnvironment }
  } catch (error) {
    await stopEmulator(child, serial)
    throw error
  }
}

const enableMockNetworkLocation = (serial) => {
  const fixtureApk = buildNetworkLocationFixture()
  run(adbPath, ['-s', serial, 'install', '-r', fixtureApk], { env: adbEnvironment })
  adb(
    ['shell', 'pm', 'grant', networkFixturePackage, 'android.permission.ACCESS_FINE_LOCATION'],
    {},
    serial,
  )
  adb(
    ['shell', 'appops', 'set', networkFixturePackage, 'android:mock_location', 'allow'],
    {},
    serial,
  )
  const result = adb(
    [
      'shell',
      'am',
      'broadcast',
      '-n',
      networkFixtureReceiver,
      '-a',
      networkFixtureAction,
      '--es',
      'operation',
      'prepare',
    ],
    {},
    serial,
  )
  if (!/Broadcast completed: result=0\b/.test(result)) {
    throw new Error('Android API 29 network mock provider was not enabled.')
  }
}

const resetMockNetworkLocation = (serial) => {
  try {
    adb(
      [
        'shell',
        'am',
        'broadcast',
        '-n',
        networkFixtureReceiver,
        '-a',
        networkFixtureAction,
        '--es',
        'operation',
        'reset',
      ],
      {},
      serial,
    )
  } catch {
    // The temporary emulator may already have stopped.
  }
  try {
    adb(['uninstall', networkFixturePackage], {}, serial)
  } catch {
    // Emulator destruction still clears the isolated fixture app.
  }
}

const runProfile = async (name, prepare, testArgs = [], selectedApk = apk) => {
  if (!fs.existsSync(selectedApk))
    throw new Error(
      'Required managed Android APK is missing; build the matching debug APK before using --skip-build.',
    )
  const mockNetwork = name === 'compat' && testArgs.includes('--network-location-fixture')
  const device = await startProfile(profile(name), prepare)
  try {
    run(adbPath, ['start-server'], { env: adbEnvironment })
    run(adbPath, ['-s', device.serial, 'install', '-r', selectedApk], { env: adbEnvironment })
    if (mockNetwork) enableMockNetworkLocation(device.serial)
    try {
      run(process.execPath, ['scripts/test-android.mjs', ...testArgs], {
        env: {
          ...adbEnvironment,
          ANDROID_SERIAL: device.serial,
          ...(testArgs.some((argument) =>
            ['--local-share-flow', '--direct-transport-smoke', '--stop-notice-smoke'].includes(
              argument,
            ),
          )
            ? { VITE_CONSTELLATION_RELAY_ADDRS: localRelayAddress }
            : {}),
        },
      })
    } catch (error) {
      const read = (args) => {
        try {
          return adb(args, { timeout: 10_000 }, device.serial)
        } catch {
          return ''
        }
      }
      const outcomes = read(['logcat', '-d', '-s', 'ConstellationRuntime:E'])
        .split(/\r?\n/)
        .flatMap((line) => line.match(/private-state-(?:load|save)-failed:[A-Za-z]+/g) ?? [])
      const crash = summarizeAndroidNativeCrash(
        read(['logcat', '-b', 'crash', '-d', '-t', '200']),
        packageName,
      )
      throw new Error(
        'Android smoke failed. Safe diagnostics: ' +
          JSON.stringify({ profile: name, protectedState: [...new Set(outcomes)], crash }),
        { cause: error },
      )
    }
  } finally {
    if (mockNetwork) resetMockNetworkLocation(device.serial)
    await stopEmulator(device.child, device.serial)
  }
}

const runManagedRestore = async (reason = 'boot') => {
  const selected = profile('modern')
  let relay
  let before
  let after
  try {
    // Keep the deterministic P2P relay across cold boot or package replacement.
    relay = spawn(process.execPath, ['scripts/e2e-relay.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
    })
    const relayDeadline = Date.now() + 30_000
    let relayReady = false
    while (Date.now() < relayDeadline) {
      if (relay.exitCode !== null) throw new Error('The local P2P relay exited during setup.')
      relayReady = await fetch('http://127.0.0.1:9113/health')
        .then((response) => response.ok)
        .catch(() => false)
      if (relayReady) break
      await wait(250)
    }
    if (!relayReady) throw new Error('The local P2P relay did not start.')

    before = await startProfile(selected)
    adb(['reverse', 'tcp:9111', 'tcp:9111'], {}, before.serial)
    run(adbPath, ['-s', before.serial, 'install', '-r', threeWayApk], { env: adbEnvironment })
    const prepareOutput = execFileSync(
      process.execPath,
      ['scripts/test-android.mjs', '--reboot-prepare-smoke'],
      {
        env: { ...adbEnvironment, ANDROID_SERIAL: before.serial },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const marker = prepareOutput
      .split(/\r?\n/)
      .find((line) => line.startsWith('[constellation-reboot-state] '))
    if (!marker) throw new Error('Reboot preparation did not report synthetic share state.')
    const expected = JSON.parse(marker.slice('[constellation-reboot-state] '.length))
    if (typeof expected.shareId !== 'string' || !Number.isFinite(expected.expiresAt)) {
      throw new Error('Reboot preparation returned invalid synthetic share state.')
    }

    if (reason === 'boot') {
      await stopEmulator(before.child, before.serial)
      before = undefined
      after = await startProfile(selected, undefined, { uninstall: false })
    } else {
      // Updating an installed background publisher must restart only its existing grants.
      adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], {}, before.serial)
      adb(['logcat', '-c'], {}, before.serial)
      run(adbPath, ['-s', before.serial, 'install', '-r', threeWayApk], {
        env: adbEnvironment,
      })
      after = before
      before = undefined
      let replacementBroadcast = false
      for (let attempt = 0; attempt < 40 && !replacementBroadcast; attempt += 1) {
        replacementBroadcast = adb(
          ['logcat', '-d', '-s', 'ConstellationRestore:I', '*:S'],
          {},
          after.serial,
        ).includes('MY_PACKAGE_REPLACED')
        if (!replacementBroadcast) await wait(250)
      }
      if (!replacementBroadcast) {
        throw new Error('MY_PACKAGE_REPLACED was not observed after the in-place update.')
      }
    }
    adb(['reverse', 'tcp:9111', 'tcp:9111'], {}, after.serial)
    run(process.execPath, ['scripts/test-android.mjs', '--reboot-verify-smoke'], {
      env: {
        ...adbEnvironment,
        ANDROID_SERIAL: after.serial,
        EXPECTED_REBOOT_SHARE_ID: expected.shareId,
        EXPECTED_REBOOT_EXPIRES_AT: String(expected.expiresAt),
      },
    })
  } finally {
    if (after) await stopEmulator(after.child, after.serial)
    if (before) await stopEmulator(before.child, before.serial)
    relay?.kill('SIGTERM')
  }
}

const runThreeWay = async () => {
  let first
  let second
  try {
    first = await startProfile(profile('modern'))
    second = await startProfile({
      ...profile('modern'),
      avdName: 'constellation-api36-play-peer',
    })
    for (const device of [first, second]) {
      run(adbPath, ['-s', device.serial, 'install', '-r', threeWayApk], { env: adbEnvironment })
    }
    run(
      process.execPath,
      [
        'scripts/test-android.mjs',
        ...(process.argv.includes('--single-viewer-comparison-smoke')
          ? ['--single-viewer-comparison-smoke']
          : []),
        ...(process.argv.includes('--preview-second-link') ? ['--preview-second-link'] : []),
        ...(process.argv.includes('--two-android-receiver-standby-smoke')
          ? ['--two-android-receiver-standby-smoke']
          : []),
        ...(process.argv.includes('--dual-role-standby-smoke')
          ? ['--dual-role-standby-smoke']
          : []),
        ...(process.argv.includes('--dual-role-process-restart')
          ? ['--dual-role-process-restart']
          : []),
        ...(process.argv.includes('--dual-role-restart-only') ? ['--dual-role-restart-only'] : []),
        ...(process.argv.includes('--power-recovery-matrix') ? ['--power-recovery-matrix'] : []),
        ...(process.argv.includes('--dual-role-permission-revocation-smoke')
          ? ['--dual-role-permission-revocation-smoke']
          : []),
        ...process.argv.filter((argument) => argument.startsWith('--standby-soak-minutes=')),
      ],
      {
        env: {
          ...adbEnvironment,
          ANDROID_SERIALS: `${first.serial},${second.serial}`,
          ANDROID_SERIAL: '',
        },
      },
    )
  } catch (error) {
    // Preserve privacy: no raw logcat, locations, peer identities or invitation URLs.
    const diagnostics = [first, second].filter(Boolean).map((device, index) => {
      const read = (args) => {
        try {
          return adb(args, {}, device.serial)
        } catch {
          return ''
        }
      }
      return {
        device: index === 0 ? 'source' : 'receiver',
        // The child test may have already force-stopped this app in its finally.
        processAliveAfterChildCleanup: Boolean(read(['shell', 'pidof', packageName]).trim()),
        crash: summarizeAndroidNativeCrash(
          read(['logcat', '-b', 'crash', '-d', '-t', '500']),
          packageName,
        ),
      }
    })
    console.error(
      '[android-acceptance] two-device failed diagnostics: ' + JSON.stringify(diagnostics),
    )
    throw error
  } finally {
    if (second) await stopEmulator(second.child, second.serial)
    if (first) await stopEmulator(first.child, first.serial)
  }
}

const buildThreeWayApk = () => {
  run(
    'bash',
    [
      'scripts/with-android-build-tools.sh',
      'yarn',
      'tauri',
      'android',
      'build',
      '--debug',
      '--apk',
      '--target',
      'x86_64',
    ],
    {
      env: { ...process.env, VITE_CONSTELLATION_RELAY_ADDRS: localRelayAddress },
    },
  )
  const source = androidApkCandidates(process.cwd(), 'debug').find((candidate) =>
    fs.existsSync(candidate),
  )
  if (!source) throw new Error('The local-relay Android build did not produce a debug APK.')
  fs.mkdirSync(path.dirname(threeWayApk), { recursive: true })
  fs.copyFileSync(source, threeWayApk)
}

ensureAdbServer()
const main = async () => {
  const soakMinutes = parseStandbySoakMinutes(process.argv)
  if (
    soakMinutes !== null &&
    !process.argv.includes('--two-android-receiver-standby-smoke') &&
    !process.argv.includes('--receiver-standby-smoke')
  ) {
    throw new Error(
      'Standby soak requires --receiver-standby-smoke or --two-android-receiver-standby-smoke.',
    )
  }
  if (process.argv.includes('--native-location-smoke')) {
    if (!fs.existsSync(apk)) throw new Error('Build the Android debug APK first.')
    await runProfile('modern', undefined, ['--native-location-smoke'])
    console.log('Owned Android location bridge returned a synthetic fix.')
    return
  }
  if (process.argv.includes('--native-store-smoke')) {
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile('modern', undefined, ['--native-store-smoke'], threeWayApk)
    console.log('Two sequential Android protected-state saves completed.')
    return
  }
  if (process.argv.includes('--local-share-flow')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    const selected = process.argv.includes('--compat-only')
      ? 'compat'
      : process.argv.includes('--no-gms-smoke')
        ? 'aosp'
        : 'modern'
    await runProfile(
      selected,
      undefined,
      ['--local-share-flow', ...(selected === 'aosp' ? ['--no-gms-flow'] : [])],
      threeWayApk,
    )
    console.log('Android sharing and return approval passed with the owned local relay.')
    return
  }
  if (process.argv.includes('--three-way')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay three-way APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runThreeWay()
    console.log('Two Android API 36 peers and one desktop browser passed the three-way test.')
    return
  }
  if (process.argv.includes('--single-viewer-comparison-smoke')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runThreeWay()
    console.log('Two Android emulators verified secure comparison before admitting location.')
    return
  }
  if (process.argv.includes('--two-android-receiver-standby-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runThreeWay()
    console.log(
      process.argv.includes('--dual-role-restart-only')
        ? 'Two Android emulators validated durable dual-role restart and authenticated location receive.'
        : 'Two Android devices validated independent Doze recovery, authenticated ACK and optional dual-role state merge.',
    )
    return
  }
  if (process.argv.includes('--receiver-standby-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runProfile(
      'modern',
      undefined,
      [
        '--receiver-standby-smoke',
        ...(process.argv.includes('--receiver-process-restart')
          ? ['--receiver-process-restart']
          : []),
        ...(process.argv.includes('--receiver-history-smoke') ? ['--receiver-history-smoke'] : []),
        ...(process.argv.includes('--notification-settings-ui') ||
        process.argv.includes('--notification-stop-ui')
          ? ['--notification-settings-ui']
          : []),
        ...process.argv.filter((argument) => argument.startsWith('--standby-soak-minutes=')),
      ],
      threeWayApk,
    )
    console.log('Saved Android receiver survived screen lock and restored Activity ownership.')
    return
  }
  if (process.argv.includes('--service-restart-smoke')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile('modern', undefined, ['--service-restart-smoke', '--local-relay'], threeWayApk)
    console.log('Android service-only process recovery retained the same source identity.')
    return
  }
  if (process.argv.includes('--activity-restart-stress-smoke')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile(
      'modern',
      undefined,
      ['--activity-restart-stress-smoke', '--local-relay'],
      threeWayApk,
    )
    console.log('Android Activity restart stress test passed.')
    return
  }
  if (process.argv.includes('--dual-role-restart-stress')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile(
      'modern',
      undefined,
      ['--local-share-flow', '--dual-role-restart-stress'],
      threeWayApk,
    )
    console.log('Android eight-cycle dual-role Activity restart stress test passed.')
    return
  }
  if (process.argv.includes('--power-state-matrix')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile('modern', undefined, ['--power-state-matrix'], threeWayApk)
    console.log('Android v0.1.5 power-state matrix completed with journal-backed evidence.')
    return
  }
  if (process.argv.includes('--power-network-smoke')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile('modern', undefined, ['--power-network-smoke'], threeWayApk)
    console.log('Android source policy, Doze and network restoration survived with a local relay.')
    return
  }
  if (!process.argv.includes('--skip-build')) {
    run('yarn', ['build:android:debug:x86_64-emulator'])
  }
  if (process.argv.includes('--notification-pause-smoke')) {
    await runProfile('modern', undefined, ['--notification-pause-smoke'])
    return
  }
  if (process.argv.includes('--location-off-smoke')) {
    await runProfile('modern', undefined, ['--location-off-smoke'])
    return
  }
  if (process.argv.includes('--permission-denial-smoke')) {
    await runProfile('modern', undefined, ['--permission-denial-smoke'])
    return
  }
  if (process.argv.includes('--expiry-smoke')) {
    await runProfile('modern', undefined, ['--expiry-smoke'])
    return
  }
  if (process.argv.includes('--foreground-only-smoke')) {
    await runProfile('modern', undefined, ['--foreground-only-smoke'])
    return
  }
  if (process.argv.includes('--multiple-source-links-smoke')) {
    await runProfile('modern', undefined, ['--multiple-source-links-smoke'])
    return
  }
  if (process.argv.includes('--stop-notice-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runProfile('modern', undefined, ['--stop-notice-smoke'], threeWayApk)
    console.log(
      'Android delivered one durable stopped-following notice and retained its dismissal.',
    )
    return
  }
  if (process.argv.includes('--direct-transport-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runProfile('modern', undefined, ['--direct-transport-smoke'], threeWayApk)
    console.log('Android classified a direct transport and kept sharing after relay shutdown.')
    return
  }
  if (process.argv.includes('--captive-transport-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runProfile('modern', undefined, ['--captive-transport-smoke'], threeWayApk)
    console.log('Android failed closed behind a captive relay and recovered with the real relay.')
    return
  }
  if (process.argv.includes('--metered-policy-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runProfile('modern', undefined, ['--metered-policy-smoke'], threeWayApk)
    console.log('Android per-link metered policy paused only the opted-in link.')
    return
  }
  if (process.argv.includes('--restricted-start-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    await runProfile('modern', undefined, ['--restricted-start-smoke'], threeWayApk)
    console.log('Android applied the network restriction before any restricted share published.')
    return
  }
  if (process.argv.includes('--reboot-smoke') || process.argv.includes('--package-replace-smoke')) {
    if (process.argv.includes('--skip-build')) {
      if (!fs.existsSync(threeWayApk)) {
        throw new Error('Build the local-relay Android APK before using --skip-build.')
      }
    } else buildThreeWayApk()
    const reason = process.argv.includes('--package-replace-smoke') ? 'update' : 'boot'
    await runManagedRestore(reason)
    console.log(
      `Android ${reason} restored an authorized share with its original identity and expiry.`,
    )
    return
  }
  if (process.argv.includes('--native-fallback-smoke')) {
    await runProfile('modern', undefined, ['--native-fallback-smoke'])
    return
  }
  if (process.argv.includes('--project-links-smoke')) {
    await runProfile('compat', undefined, ['--project-links-smoke'])
    console.log(
      'Android project links opened the allowlisted destination and failed safely without a browser.',
    )
    return
  }
  if (process.argv.includes('--ui-policy-smoke')) {
    await runProfile('modern', undefined, ['--ui-policy-smoke'])
    return
  }
  if (process.argv.includes('--no-gms-smoke')) {
    await runProfile('aosp', undefined, ['--no-gms-flow'])
    console.log('Android API 29 AOSP/no-GMS location-sharing flow passed.')
    return
  }
  if (process.argv.includes('--modern-only')) {
    await runProfile('modern')
    console.log('Android API 36 location-sharing tests passed.')
    return
  }
  if (process.argv.includes('--compat-only')) {
    if (!process.argv.includes('--skip-build')) buildThreeWayApk()
    if (!fs.existsSync(threeWayApk)) throw new Error('Build the local-relay Android APK first.')
    await runProfile(
      'compat',
      undefined,
      ['--local-share-flow', '--network-location-fixture'],
      threeWayApk,
    )
    console.log('Android API 29 compatibility sharing and locked-screen delivery passed.')
    return
  }
  if (process.argv.includes('--skip-build')) {
    if (!fs.existsSync(apk) || !fs.existsSync(threeWayApk)) {
      throw new Error('The full --skip-build matrix requires both retained Android debug APKs.')
    }
  }
  await runProfile('modern')
  if (!process.argv.includes('--skip-build')) buildThreeWayApk()
  await runProfile(
    'compat',
    undefined,
    ['--local-share-flow', '--network-location-fixture'],
    threeWayApk,
  )
  await runProfile('aosp', undefined, ['--no-gms-flow'])
  await runProfile('modern', undefined, ['--notification-pause-smoke'])
  await runProfile('modern', undefined, ['--permission-denial-smoke'])
  await runProfile('modern', undefined, ['--location-off-smoke'])
  await runProfile('modern', undefined, ['--expiry-smoke'])
  await runProfile('modern', undefined, ['--foreground-only-smoke'])
  await runProfile('modern', undefined, ['--multiple-source-links-smoke'])
  await runProfile('modern', undefined, ['--native-fallback-smoke'])
  await runProfile('modern', undefined, ['--ui-policy-smoke'])

  await runProfile('modern', undefined, ['--power-network-smoke'], threeWayApk)
  await runProfile('modern', undefined, ['--service-restart-smoke', '--local-relay'], threeWayApk)
  await runManagedRestore('boot')
  await runManagedRestore('update')
  console.log('Android API 29 stock/no-GMS and API 36 location-sharing tests passed.')
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
