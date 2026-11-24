import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
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
  if (sdk && name === 'avdmanager') {
    const tools = path.join(sdk, 'cmdline-tools')
    if (fs.existsSync(tools)) {
      const versions = fs
        .readdirSync(tools)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      for (const version of ['latest', ...versions.filter((value) => value !== 'latest')]) {
        const executable = path.join(tools, version, 'bin', name)
        if (fs.existsSync(executable)) return executable
      }
    }
  }
  return sdk ? path.join(sdk, ...segments) : name
}

// AOSP images can live in a minimal SDK root without their own emulator binary.
// Keep the profile SDK for system-image resolution, but use the host toolchain
// when that isolated SDK does not provide its own executable.
export const emulatorExecutable = (
  profileEnvironment = process.env,
  hostEnvironment = process.env,
) => {
  const local = androidTool('emulator', profileEnvironment)
  if (fs.existsSync(local)) return local
  const host = androidTool('emulator', hostEnvironment)
  if (fs.existsSync(host)) return host
  throw new Error(`Android emulator binary unavailable in profile or host SDK: ${local}`)
}

export const androidAdbEnvironment = (environment = process.env) => {
  const localEnvironment = { ...environment }
  delete localEnvironment.ADB_SERVER_SOCKET
  if (localEnvironment.ADB_VENDOR_KEYS) return localEnvironment
  const emulatorHome = localEnvironment.ANDROID_EMULATOR_HOME
  const persistedKey = emulatorHome ? path.join(emulatorHome, 'adbkey') : undefined
  return persistedKey && fs.existsSync(persistedKey)
    ? { ...localEnvironment, ADB_VENDOR_KEYS: persistedKey }
    : localEnvironment
}

// A shared ADB server may discover another project's device during our boot.
// Never install, uninstall, or send emulator controls until the AVD is identified.
export const findManagedEmulatorSerial = (serials, previousSerials, avdName, readAvdName) =>
  serials.find((serial) => {
    if (!/^emulator-\d+$/.test(serial) || previousSerials.has(serial)) return false
    try {
      return readAvdName(serial).split(/\r?\n/)[0]?.trim() === avdName
    } catch {
      return false
    }
  })

const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  })

const avdExists = (avdName, environment = process.env) => {
  const avdHome =
    environment.ANDROID_AVD_HOME ??
    (environment.HOME ? path.join(environment.HOME, '.android', 'avd') : undefined)
  if (avdHome && fs.existsSync(path.join(avdHome, `${avdName}.ini`))) return true
  try {
    const output = execFileSync(androidTool('avdmanager', environment), ['list', 'avd', '-c'], {
      encoding: 'utf8',
      env: environment,
    })
    return output.split(/\r?\n/).includes(avdName)
  } catch {
    return false
  }
}

export const create = (selected, environment = process.env) => {
  if (avdExists(selected.avdName, environment)) return
  run(
    androidTool('avdmanager', environment),
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
    { input: 'no\n', stdio: ['pipe', 'inherit', 'inherit'], env: environment },
  )
}

export const profile = (name, environment = process.env) => {
  if (name === 'compat')
    return {
      avdName: 'constellation-api29',
      systemImage: 'system-images;android-29;google_apis_playstore;x86_64',
    }
  if (name === 'aosp')
    return {
      avdName: 'constellation-api29-aosp',
      systemImage: 'system-images;android-29;default;x86_64',
      ...(environment.ANDROID_AOSP_SDK_ROOT ? { sdkRoot: environment.ANDROID_AOSP_SDK_ROOT } : {}),
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
  ...(selected.sdkRoot
    ? ['-sysdir', path.join(selected.sdkRoot, ...selected.systemImage.split(';'))]
    : []),
  '-gpu',
  'swiftshader_indirect',
  '-no-audio',
  '-no-metrics',
  '-no-snapshot-load',
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
