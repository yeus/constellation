import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { androidTool, create, emulatorArguments, profile } from './android-emulator.mjs'
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
const emulatorPath = androidTool('emulator')

const adb = (args, options = {}, serial) =>
  execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })

const wait = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

const pull = (serial, remote, destination) => {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      run(adbPath, ['-s', serial, 'pull', remote, destination])
      return
    } catch (error) {
      lastError = error
      if (fs.existsSync(destination)) fs.unlinkSync(destination)
    }
  }
  throw lastError
}

const onlineSerials = () =>
  adb(['devices'])
    .split('\n')
    .slice(1)
    .filter((line) => /\sdevice(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0])

const waitForBoot = async (child, avdName, previousSerials) => {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${avdName} exited before booting.`)
    try {
      const serial = onlineSerials().find((candidate) => !previousSerials.has(candidate))
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
  throw new Error(`${avdName} did not finish booting.`)
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

const captureWebView = (directory, serial) => {
  const webViewPath = adb(['shell', 'pm', 'path', 'com.google.android.webview'], {}, serial)
    .split(/\r?\n/)
    .map((line) => line.replace(/^package:/, '').trim())
    .find(Boolean)
  if (!webViewPath) throw new Error('The API 36 emulator has no Android System WebView APK.')

  const compressedLibrary = path.join(directory, 'TrichromeLibrary.apk.gz')
  const libraryApk = path.join(directory, 'TrichromeLibrary.apk')
  const webViewApk = path.join(directory, 'WebViewGoogle.apk')
  pull(serial, webViewPath, webViewApk)
  pull(serial, '/product/app/TrichromeLibrary/TrichromeLibrary.apk.gz', compressedLibrary)
  fs.writeFileSync(libraryApk, gunzipSync(fs.readFileSync(compressedLibrary)))

  const details = adb(['shell', 'dumpsys', 'package', 'com.google.android.webview'], {}, serial)
  const version = details.match(/versionName=([^\s]+)/)?.[1]
  if (!version) throw new Error('Could not determine the API 36 WebView version.')
  return { libraryApk, webViewApk, version }
}

const installWebView = (fixture, serial) => {
  run(adbPath, ['-s', serial, 'install', '-r', '-d', fixture.libraryApk])
  run(adbPath, ['-s', serial, 'install', '-r', '-d', fixture.webViewApk])
  run(adbPath, [
    '-s',
    serial,
    'shell',
    'cmd',
    'webviewupdate',
    'set-webview-implementation',
    'com.google.android.webview',
  ])
  const state = adb(['shell', 'dumpsys', 'webviewupdate'], {}, serial)
  if (!state.includes(`(com.google.android.webview, ${fixture.version})`)) {
    throw new Error(`API 29 did not select WebView ${fixture.version}.`)
  }
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

const startProfile = async (selected, prepare) => {
  create(selected)
  const previousSerials = new Set(onlineSerials())
  const child = spawn(emulatorPath, emulatorArguments(selected, ['-no-window', '-no-boot-anim']), {
    stdio: 'ignore',
  })
  let serial
  try {
    serial = await waitForBoot(child, selected.avdName, previousSerials)
    uninstallIfPresent(serial)
    await prepare?.(serial)
    return { child, serial }
  } catch (error) {
    await stopEmulator(child, serial)
    throw error
  }
}

const runProfile = async (name, prepare, testArgs = [], selectedApk = apk) => {
  const device = await startProfile(profile(name), prepare)
  try {
    run(adbPath, ['-s', device.serial, 'install', '-r', selectedApk])
    run(process.execPath, ['scripts/test-android.mjs', ...testArgs], {
      env: { ...process.env, ANDROID_SERIAL: device.serial },
    })
  } finally {
    await stopEmulator(device.child, device.serial)
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
          ...process.env,
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
  if (process.argv.includes('--modern-only')) {
    await runProfile('modern')
    console.log('Android API 36 location-sharing tests passed.')
    return
  }
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-webview-'))
  try {
    let fixture
    await runProfile('modern', (serial) => {
      fixture = captureWebView(fixtureDirectory, serial)
    })
    await runProfile('compat', (serial) => {
      if (!fixture) throw new Error('The modern WebView fixture was not captured.')
      installWebView(fixture, serial)
    })
    console.log('Android API 29 and API 36 location-sharing tests passed.')
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
