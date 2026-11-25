import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  androidAdbEnvironment,
  androidTool,
  create,
  emulatorArguments,
  emulatorLaunch,
  findManagedEmulatorSerial,
  parseAdbDevices,
  profile,
  removeInstalledTestPackage,
} from './android-emulator.mjs'

test('resolves Android tools from ANDROID_HOME', () => {
  assert.equal(androidTool('adb', { ANDROID_HOME: '/sdk' }), '/sdk/platform-tools/adb')
  assert.equal(androidTool('emulator', { ANDROID_HOME: '/sdk' }), '/sdk/emulator/emulator')
  assert.equal(
    androidTool('avdmanager', { ANDROID_HOME: '/sdk' }),
    '/sdk/cmdline-tools/latest/bin/avdmanager',
  )
})

test('selects only the newly launched owned emulator, including a reused serial after reboot', () => {
  const devices = parseAdbDevices(
    [
      'List of devices attached',
      'physical-device device transport_id:1',
      'emulator-5554 device transport_id:2',
      'emulator-5556 device transport_id:3',
      'emulator-5558 device transport_id:4',
      'emulator-5560 device transport_id:5',
      '',
    ].join('\n'),
  )
  const previous = new Set(['emulator-5554:transport_id:2', 'emulator-5560:transport_id:1'])
  const readAvdName = (serial) => {
    if (serial === 'emulator-5556') throw new Error('not ready')
    return serial === 'emulator-5560' ? 'constellation-api36-play\nOK\n' : 'another-project\nOK\n'
  }
  assert.equal(
    findManagedEmulatorSerial(devices, previous, 'constellation-api36-play', readAvdName),
    'emulator-5560',
  )
  assert.equal(
    findManagedEmulatorSerial(
      devices.slice(0, -1),
      previous,
      'constellation-api36-play',
      readAvdName,
    ),
    undefined,
  )
  assert.equal(
    findManagedEmulatorSerial(
      devices,
      new Set([...previous, 'emulator-5560:transport_id:5']),
      'constellation-api36-play',
      readAvdName,
    ),
    undefined,
  )
})

test('clears a retained package but never treats an ADB failure as absence', () => {
  const name = 'space.taskyon.constellation'
  let installed = true
  let uninstalls = 0
  const adb = (args) => {
    if (args[0] === 'uninstall') {
      uninstalls += 1
      installed = false
      return 'Success\n'
    }
    return installed ? `package:${name}\n` : `package:${name}.other\n`
  }
  removeInstalledTestPackage(adb, name)
  removeInstalledTestPackage(adb, name)
  assert.equal(uninstalls, 1)
  assert.throws(
    () =>
      removeInstalledTestPackage(() => {
        throw new Error('ADB offline')
      }, name),
    /ADB offline/,
  )
  assert.throws(
    () =>
      removeInstalledTestPackage(
        (args) => (args[0] === 'uninstall' ? 'Failure' : `package:${name}`),
        name,
      ),
    /Could not remove/,
  )
})

test('finds versioned Android command-line tools without a latest symlink', () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-sdk-'))
  try {
    const executable = path.join(sdk, 'cmdline-tools', '13.0', 'bin', 'avdmanager')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '')
    assert.equal(androidTool('avdmanager', { ANDROID_HOME: sdk }), executable)
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true })
  }
})

test('uses the host emulator binary for an AOSP SDK that contains only a system image', () => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-isolated-sdk-'))
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-host-sdk-'))
  try {
    const executable = path.join(host, 'emulator', 'emulator')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '')
    const profileEnv = { ANDROID_HOME: sdk }
    const hostEnv = { ANDROID_HOME: host }
    assert.deepEqual(emulatorLaunch(profileEnv, hostEnv), {
      executable,
      environment: hostEnv,
    })
    const local = path.join(sdk, 'emulator', 'emulator')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, '')
    assert.deepEqual(emulatorLaunch(profileEnv, hostEnv), {
      executable,
      environment: hostEnv,
    })
    assert.deepEqual(emulatorLaunch(profileEnv, { ANDROID_HOME: '/missing' }), {
      executable: local,
      environment: profileEnv,
    })
  } finally {
    fs.rmSync(sdk, { recursive: true, force: true })
    fs.rmSync(host, { recursive: true, force: true })
  }
})

test('reuses a persisted emulator ADB key when one is available', () => {
  const emulatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-emulator-'))
  try {
    const key = path.join(emulatorHome, 'adbkey')
    fs.writeFileSync(key, 'synthetic')
    assert.equal(
      androidAdbEnvironment({ ANDROID_EMULATOR_HOME: emulatorHome }).ADB_VENDOR_KEYS,
      key,
    )
    const explicit = androidAdbEnvironment({
      ANDROID_EMULATOR_HOME: emulatorHome,
      ADB_VENDOR_KEYS: '/explicit/key',
      ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5037',
    })
    assert.equal(explicit.ADB_VENDOR_KEYS, '/explicit/key')
    assert.equal('ADB_SERVER_SOCKET' in explicit, false)
  } finally {
    fs.rmSync(emulatorHome, { recursive: true, force: true })
  }
})

test('defines the supported Android compatibility profiles', () => {
  assert.deepEqual(profile('compat'), {
    avdName: 'constellation-api29',
    systemImage: 'system-images;android-29;google_apis_playstore;x86_64',
  })
  assert.deepEqual(profile('aosp', {}), {
    avdName: 'constellation-api29-aosp',
    systemImage: 'system-images;android-29;default;x86_64',
  })
  assert.deepEqual(profile('modern'), {
    avdName: 'constellation-api36-play',
    systemImage: 'system-images;android-36;google_apis_playstore;x86_64',
  })
  assert.throws(() => profile('unknown'), /Unknown Android emulator profile/)
})

test('accepts an existing AVD without requiring avdmanager', () => {
  const avdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-avd-'))
  try {
    fs.writeFileSync(path.join(avdHome, 'existing.ini'), 'path=/synthetic\n')
    assert.doesNotThrow(() =>
      create(
        { avdName: 'existing', systemImage: 'system-images;missing' },
        { ANDROID_AVD_HOME: avdHome, ANDROID_HOME: '/missing-sdk' },
      ),
    )
  } finally {
    fs.rmSync(avdHome, { recursive: true, force: true })
  }
})

test('starts deterministic software-rendered emulators', () => {
  assert.deepEqual(emulatorArguments(profile('modern'), ['-no-window']), [
    '-avd',
    'constellation-api36-play',
    '-gpu',
    'swiftshader_indirect',
    '-no-audio',
    '-no-metrics',
    '-no-snapshot-load',
    '-no-snapshot-save',
    '-no-window',
  ])
})

test('AOSP emulator uses its separate system-image directory with the host binary', () => {
  assert.deepEqual(
    emulatorArguments(profile('aosp', { ANDROID_AOSP_SDK_ROOT: '/synthetic/aosp-sdk' })).slice(
      0,
      4,
    ),
    [
      '-avd',
      'constellation-api29-aosp',
      '-sysdir',
      '/synthetic/aosp-sdk/system-images/android-29/default/x86_64',
    ],
  )
})
