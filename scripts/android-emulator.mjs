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

// An isolated SDK may contain only an image. The emulator needs the SDK
// containing its binary, while -sysdir independently selects the image.
export const emulatorLaunch = (profileEnvironment = process.env, hostEnvironment = process.env) => {
  const host = androidTool('emulator', hostEnvironment)
  if (fs.existsSync(host)) return { executable: host, environment: hostEnvironment }
  const local = androidTool('emulator', profileEnvironment)
  if (fs.existsSync(local)) return { executable: local, environment: profileEnvironment }
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

// ADB may reuse an emulator serial after a cold boot, but assigns a fresh
// transport ID. Identify the new transport and its AVD before any mutation.
export const parseAdbDevices = (output) =>
  output
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [serial, state, ...fields] = line.trim().split(/\s+/)
      if (!serial || !state) return []
      const transport = fields.find((field) => field.startsWith('transport_id:'))
      return [{ serial, state, identity: transport ? `${serial}:${transport}` : serial }]
    })

export const findManagedEmulatorSerial = (devices, previousIdentities, avdName, readAvdName) =>
  devices.find(({ serial, state, identity }) => {
    if (state !== 'device' || !/^emulator-\d+$/.test(serial) || previousIdentities.has(identity))
      return false
    try {
      return readAvdName(serial).split(/\r?\n/)[0]?.trim() === avdName
    } catch {
      return false
    }
  })?.serial

// Inspect retained packages too; a different debug signing key can otherwise
// leave a stale package that prevents installation. Propagate transport errors.
export const removeInstalledTestPackage = (adb, packageName) => {
  const installed = () =>
    adb(['shell', 'pm', 'list', 'packages', '-u', packageName], { timeout: 10_000 })
      .split(/\r?\n/)
      .some((line) => line.trim() === `package:${packageName}`)
  if (!installed()) return
  const result = adb(['uninstall', packageName], { timeout: 60_000 })
  if (result.trim() !== 'Success' || installed()) {
    throw new Error('Could not remove the existing package from the owned test emulator.')
  }
}

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
      ...(environment.ANDROID_COMPAT_SDK_ROOT
        ? { sdkRoot: environment.ANDROID_COMPAT_SDK_ROOT }
        : {}),
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

export const requireProfileImage = (selected, environment = process.env) => {
  const sdk = selected.sdkRoot ?? environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT
  if (!sdk) return
  const image = path.join(sdk, ...selected.systemImage.split(';'), 'system.img')
  if (!fs.existsSync(image)) {
    throw new Error(
      `Android system image is missing for ${selected.avdName}: ${selected.systemImage}. Check the selected SDK root.`,
    )
  }
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
