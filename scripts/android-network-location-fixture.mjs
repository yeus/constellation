import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const networkFixturePackage = 'space.taskyon.constellation.locationfixture'
export const networkFixtureReceiver = `${networkFixturePackage}/.NetworkLocationFixture`
export const networkFixtureAction = `${networkFixturePackage}.COMMAND`

const run = (executable, args) =>
  execFileSync(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })

const findBuildTools = (sdk) => {
  for (const version of ['36.1.0', '36.0.0', '35.0.0']) {
    const folder = path.join(sdk, 'build-tools', version)
    if (
      ['aapt2', 'd8', 'zipalign', 'apksigner'].every((name) => existsSync(path.join(folder, name)))
    ) {
      return folder
    }
  }
  throw new Error('Android build tools 35+ are required for the emulator-only location fixture.')
}

export const buildNetworkLocationFixture = (sdk = process.env.ANDROID_HOME) => {
  if (!sdk) throw new Error('ANDROID_HOME is required to build the Android location fixture.')
  const jar = path.join(sdk, 'platforms', 'android-36', 'android.jar')
  if (!existsSync(jar))
    throw new Error('Android API 36 platform is required for the fixture build.')
  const tools = findBuildTools(sdk)
  const source = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'android-network-location',
  )
  const target = path.resolve('dist', 'constellation-network-location-fixture.apk')
  const directory = mkdtempSync(path.join(tmpdir(), 'constellation-network-fixture-'))
  const classes = path.join(directory, 'classes')
  const dex = path.join(directory, 'dex')
  mkdirSync(classes)
  mkdirSync(dex)
  mkdirSync(path.dirname(target), { recursive: true })
  try {
    run('javac', [
      '--release',
      '8',
      '-cp',
      jar,
      '-d',
      classes,
      path.join(source, 'NetworkLocationFixture.java'),
    ])
    run(path.join(tools, 'd8'), [
      '--min-api',
      '29',
      '--lib',
      jar,
      '--output',
      dex,
      path.join(classes, ...networkFixturePackage.split('.'), 'NetworkLocationFixture.class'),
    ])
    const unsigned = path.join(directory, 'unsigned.apk')
    const aligned = path.join(directory, 'aligned.apk')
    run(path.join(tools, 'aapt2'), [
      'link',
      '-o',
      unsigned,
      '-I',
      jar,
      '--manifest',
      path.join(source, 'AndroidManifest.xml'),
    ])
    run('zip', ['-q', '-j', unsigned, path.join(dex, 'classes.dex')])
    run(path.join(tools, 'zipalign'), ['-f', '4', unsigned, aligned])
    const keystore = path.join(directory, 'fixture.keystore')
    run('keytool', [
      '-genkeypair',
      '-noprompt',
      '-keystore',
      keystore,
      '-storepass',
      'android',
      '-keypass',
      'android',
      '-alias',
      'fixture',
      '-dname',
      'CN=Constellation Emulator Fixture',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '2',
    ])
    run(path.join(tools, 'apksigner'), [
      'sign',
      '--ks',
      keystore,
      '--ks-pass',
      'pass:android',
      '--ks-key-alias',
      'fixture',
      '--key-pass',
      'pass:android',
      '--out',
      target,
      aligned,
    ])
    run(path.join(tools, 'apksigner'), ['verify', '--min-sdk-version', '29', target])
    return target
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildNetworkLocationFixture())
}
