import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  androidAdbEnvironment,
  androidTool,
  create,
  emulatorArguments,
  profile,
} from './android-emulator.mjs'
import { androidApkCandidates } from './copy-android-apk.mjs'

const packageName = 'space.taskyon.constellation'
const apk = 'dist/constellation-android-debug-x86_64.apk'
const threeWayApk = 'dist/constellation-android-e2e-local-x86_64.apk'
const localRelayAddress = '/ip4/127.0.0.1/tcp/9111/ws'

const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    stdio: 'inherit',
    ...options,
  })

const adbPath = androidTool('adb')
const adbEnvironment = androidAdbEnvironment()

const restartAdbServer = () => {
  run(adbPath, ['kill-server'], { env: adbEnvironment })
  run(adbPath, ['start-server'], { env: adbEnvironment })
}

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

const onlineSerials = () =>
  adb(['devices'])
    .split('\n')
    .slice(1)
    .filter((line) => /\sdevice(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0])

const waitForBoot = async (child, avdName, previousSerials) => {
  const deadline = Date.now() + 180_000
  let onlineDevices = 0
  let newDevices = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${avdName} exited before booting.`)
    try {
      const available = onlineSerials()
      onlineDevices = available.length
      const candidates = available.filter((candidate) => !previousSerials.has(candidate))
      newDevices = candidates.length
      const serial = candidates[0]
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
  const deadline = Date.now() + 15_000
  while (child.exitCode === null && Date.now() < deadline) await wait(250)
  if (child.exitCode === null) child.kill('SIGTERM')
}

const uninstallIfPresent = (serial) => {
  try {
    if (adb(['shell', 'pm', 'path', packageName], { timeout: 10_000 }, serial).trim()) {
      run(adbPath, ['-s', serial, 'uninstall', packageName])
    }
  } catch {
    // The package is not installed.
  }
}

const startProfile = async (selected, prepare, { uninstall = true } = {}) => {
  const profileEnvironment = selected.sdkRoot
    ? {
        ...adbEnvironment,
        ANDROID_HOME: selected.sdkRoot,
        ANDROID_SDK_ROOT: selected.sdkRoot,
      }
    : adbEnvironment
  create(selected, profileEnvironment)
  const previousSerials = new Set(onlineSerials())
  const selectedEmulatorPath = androidTool('emulator', profileEnvironment)
  const child = spawn(
    selectedEmulatorPath,
    emulatorArguments(selected, ['-no-window', '-no-boot-anim']),
    {
      stdio: 'ignore',
      env: profileEnvironment,
    },
  )
  let serial
  try {
    serial = await waitForBoot(child, selected.avdName, previousSerials)
    adb(['shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1'], {}, serial)
    if (uninstall) uninstallIfPresent(serial)
    await prepare?.(serial)
    return { child, serial, profileEnvironment }
  } catch (error) {
    await stopEmulator(child, serial)
    throw error
  }
}

const runProfile = async (name, prepare, testArgs = [], selectedApk = apk) => {
  const device = await startProfile(profile(name), prepare)
  try {
    run(adbPath, ['start-server'], { env: adbEnvironment })
    run(adbPath, ['-s', device.serial, 'install', '-r', selectedApk], { env: adbEnvironment })
    run(process.execPath, ['scripts/test-android.mjs', ...testArgs], {
      env: {
        ...adbEnvironment,
        ANDROID_SERIAL: device.serial,
        ...(testArgs.some((argument) =>
          ['--local-share-flow', '--direct-transport-smoke'].includes(argument),
        )
          ? { VITE_CONSTELLATION_RELAY_ADDRS: localRelayAddress }
          : {}),
      },
    })
  } finally {
    await stopEmulator(device.child, device.serial)
  }
}

const runManagedPowerCycle = async () => {
  const selected = profile('modern')
  let before
  let after
  try {
    before = await startProfile(selected)
    run(adbPath, ['-s', before.serial, 'install', '-r', apk], { env: adbEnvironment })
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

    await stopEmulator(before.child, before.serial)
    before = undefined
    after = await startProfile(selected, undefined, { uninstall: false })
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
      run(adbPath, ['-s', device.serial, 'install', '-r', threeWayApk])
    }
    run(
      process.execPath,
      [
        'scripts/test-android.mjs',
        ...(process.argv.includes('--preview-second-link') ? ['--preview-second-link'] : []),
      ],
      {
        env: {
          ...adbEnvironment,
          ANDROID_SERIALS: `${first.serial},${second.serial}`,
          ANDROID_SERIAL: '',
        },
      },
    )
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

restartAdbServer()
const main = async () => {
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
  if (!process.argv.includes('--skip-build')) {
    run('yarn', ['build:android:debug:x86_64-emulator'])
  }
  if (process.argv.includes('--notification-stop-smoke')) {
    await runProfile('modern', undefined, ['--notification-stop-smoke'])
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
  if (process.argv.includes('--service-restart-smoke')) {
    await runProfile('modern', undefined, ['--service-restart-smoke'])
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
  if (process.argv.includes('--power-network-smoke')) {
    await runProfile('modern', undefined, ['--power-network-smoke'])
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
  if (process.argv.includes('--reboot-smoke')) {
    await runManagedPowerCycle()
    console.log('Android power-cycle preserved protected share identity and absolute expiry.')
    return
  }
  if (process.argv.includes('--native-fallback-smoke')) {
    await runProfile('modern', undefined, ['--native-fallback-smoke'])
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
    await runProfile('compat')
    console.log('Android API 29 compatibility location-sharing tests passed.')
    return
  }
  await runProfile('modern')
  await runProfile('compat')
  await runProfile('aosp', undefined, ['--no-gms-flow'])
  await runProfile('modern', undefined, ['--notification-stop-smoke'])
  await runProfile('modern', undefined, ['--permission-denial-smoke'])
  await runProfile('modern', undefined, ['--expiry-smoke'])
  await runProfile('modern', undefined, ['--foreground-only-smoke'])
  await runProfile('modern', undefined, ['--multiple-source-links-smoke'])
  await runProfile('modern', undefined, ['--native-fallback-smoke'])
  await runProfile('modern', undefined, ['--ui-policy-smoke'])
  await runProfile('modern', undefined, ['--power-network-smoke'])
  await runProfile('modern', undefined, ['--service-restart-smoke'])
  await runManagedPowerCycle()
  console.log('Android API 29 stock/no-GMS and API 36 location-sharing tests passed.')
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
