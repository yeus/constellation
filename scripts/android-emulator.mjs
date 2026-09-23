import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const androidToolPaths = {
  adb: ['platform-tools', 'adb'],
  avdmanager: ['cmdline-tools', 'latest', 'bin', 'avdmanager'],
  emulator: ['emulator', 'emulator'],
}

export const androidTool = (name, environment = process.env) => {
  const sdk = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT
  const segments = androidToolPaths[name]
  if (!segments) throw new Error(`Unknown Android tool: ${name}`)
  return sdk ? path.join(sdk, ...segments) : name
}

const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  })

const avdExists = (avdName) => {
  try {
    const output = execFileSync(androidTool('avdmanager'), ['list', 'avd', '-c'], {
      encoding: 'utf8',
    })
    return output.split(/\r?\n/).includes(avdName)
  } catch {
    return false
  }
}

export const create = (selected) => {
  if (avdExists(selected.avdName)) return
  run(
    androidTool('avdmanager'),
    [
      'create',
      'avd',
      '--name',
      selected.avdName,
      '--package',
      selected.systemImage,
      '--device',
      'pixel_2',
    ],
    { input: 'no\n', stdio: ['pipe', 'inherit', 'inherit'] },
  )
}

export const profile = (name) => {
  if (name === 'compat')
    return {
      avdName: 'constellation-api29',
      systemImage: 'system-images;android-29;google_apis_playstore;x86_64',
    }
  if (name === 'modern')
    return {
      avdName: 'constellation-api36-play',
      systemImage: 'system-images;android-36;google_apis_playstore;x86_64',
    }
  throw new Error(`Unknown Android emulator profile: ${name}`)
}

export const emulatorArguments = (selected, extraArguments = []) => [
  '-avd',
  selected.avdName,
  '-gpu',
  'swiftshader_indirect',
  '-no-audio',
  '-no-metrics',
  '-no-snapshot-save',
  ...extraArguments,
]

const main = (args) => {
  const command = args[0] ?? 'start'
  const selected = profile(args[1] ?? 'compat')
  const extraArguments = args.slice(2).filter((argument) => argument !== '--')
  if (command === 'create') {
    create(selected)
    return
  }
  if (command !== 'start') {
    throw new Error('Usage: android-emulator.mjs <create|start> [compat|modern]')
  }
  create(selected)
  run(androidTool('emulator'), emulatorArguments(selected, extraArguments))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
