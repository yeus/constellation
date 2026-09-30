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
  profile,
} from './android-emulator.mjs'

test('resolves Android tools from ANDROID_HOME', () => {
  assert.equal(androidTool('adb', { ANDROID_HOME: '/sdk' }), '/sdk/platform-tools/adb')
  assert.equal(androidTool('emulator', { ANDROID_HOME: '/sdk' }), '/sdk/emulator/emulator')
  assert.equal(
    androidTool('avdmanager', { ANDROID_HOME: '/sdk' }),
    '/sdk/cmdline-tools/latest/bin/avdmanager',
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
  assert.deepEqual(profile('aosp'), {
    avdName: 'constellation-api29-aosp',
    systemImage: 'system-images;android-29;default;x86_64',
    sdkRoot: '/android-state/aosp-sdk',
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
    '-no-snapshot-save',
    '-no-window',
  ])
})
