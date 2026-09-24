import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { androidTool, emulatorArguments, profile } from './android-emulator.mjs'

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

test('defines the supported Android compatibility profiles', () => {
  assert.deepEqual(profile('compat'), {
    avdName: 'constellation-api29',
    systemImage: 'system-images;android-29;google_apis_playstore;x86_64',
  })
  assert.deepEqual(profile('modern'), {
    avdName: 'constellation-api36-play',
    systemImage: 'system-images;android-36;google_apis_playstore;x86_64',
  })
  assert.throws(() => profile('unknown'), /Unknown Android emulator profile/)
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
