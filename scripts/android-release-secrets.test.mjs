import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const createFixture = (t, secretStore = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-signing-secrets-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const bin = path.join(root, 'bin')
  const home = path.join(root, 'home')
  const config = path.join(home, '.config')
  const storePath = path.join(root, 'secret-store.json')
  const keytoolCalls = path.join(root, 'keytool-calls')
  fs.mkdirSync(bin)
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify(secretStore))

  fs.writeFileSync(
    path.join(bin, 'secret-tool'),
    `#!/usr/bin/env node
import fs from 'node:fs'
const storePath = process.env.CONSTELLATION_TEST_SECRET_STORE
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'))
const args = process.argv.slice(3)
const attributes = new Map()
for (let index = 0; index < args.length;) {
  if (args[index] === '--label') index += 2
  else {
    attributes.set(args[index], args[index + 1])
    index += 2
  }
}
const key = attributes.get('key')
if (process.argv[2] === 'lookup') {
  if (typeof store[key] !== 'string') process.exit(1)
  process.stdout.write(store[key])
} else if (process.argv[2] === 'store') {
  let value = ''
  for await (const chunk of process.stdin) value += chunk
  store[key] = value
  fs.writeFileSync(storePath, JSON.stringify(store))
} else {
  process.exit(2)
}
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(bin, 'keytool'),
    `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
fs.appendFileSync(process.env.CONSTELLATION_TEST_KEYTOOL_CALLS, args[0] + '\\n')
if (args[0] === '-genkeypair') {
  fs.writeFileSync(option('-keystore'), 'synthetic-generated-keystore')
  process.exit(0)
}
if (args[0] === '-list') {
  const contents = fs.readFileSync(option('-keystore'), 'utf8')
  process.exit(contents.startsWith('synthetic-') ? 0 : 1)
}
process.exit(2)
`,
    { mode: 0o755 },
  )

  return {
    bin,
    config,
    home,
    keytoolCalls,
    storePath,
    env: {
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: config,
      CONSTELLATION_TEST_SECRET_STORE: storePath,
      CONSTELLATION_TEST_KEYTOOL_CALLS: keytoolCalls,
    },
  }
}

const runPrepare = (fixture, environment = {}) =>
  spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$1"; prepare_constellation_android_signing',
      'test',
      path.join(projectRoot, 'scripts/android-release-secrets.sh'),
    ],
    { encoding: 'utf8', env: { ...fixture.env, ...environment } },
  )

test('creates missing signing credentials and persists them to Secret Service', (t) => {
  const fixture = createFixture(t)
  const result = runPrepare(fixture)
  const store = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'))
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(store.android_key_alias, 'constellation-release-key')
  assert.equal(store.android_keystore_path, keystorePath)
  assert.match(store.android_keystore_password, /^[A-Za-z0-9]{32}$/)
  assert.match(store.android_key_password, /^[A-Za-z0-9]{32}$/)
  assert.equal(
    store.android_keystore_base64,
    Buffer.from('synthetic-generated-keystore').toString('base64'),
  )
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-generated-keystore')
  assert.equal(fs.statSync(keystorePath).mode & 0o777, 0o600)
  assert.equal(
    `${result.stdout}\n${result.stderr}`.includes(store.android_keystore_password),
    false,
  )
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(store.android_key_password), false)

  const repeatedResult = runPrepare(fixture)
  const repeatedStore = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'))
  assert.equal(repeatedResult.status, 0, `${repeatedResult.stdout}\n${repeatedResult.stderr}`)
  assert.equal(repeatedStore.android_keystore_password, store.android_keystore_password)
  assert.equal(repeatedStore.android_key_password, store.android_key_password)
  assert.equal(repeatedStore.android_keystore_base64, store.android_keystore_base64)
  assert.deepEqual(fs.readFileSync(fixture.keytoolCalls, 'utf8').trim().split('\n'), [
    '-genkeypair',
    '-list',
    '-list',
  ])
})

test('restores a missing local keystore from Secret Service without regenerating it', (t) => {
  const fixture = createFixture(t)
  const expectedPath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: expectedPath,
      android_keystore_base64: Buffer.from('synthetic-restored-keystore').toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )
  const result = runPrepare(fixture)
  const calls = fs.readFileSync(fixture.keytoolCalls, 'utf8')

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(fs.readFileSync(expectedPath, 'utf8'), 'synthetic-restored-keystore')
  assert.equal(fs.statSync(expectedPath).mode & 0o777, 0o600)
  assert.match(calls, /^-list\n$/)
})

test('refuses to replace an existing keystore that does not match stored credentials', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true })
  fs.writeFileSync(keystorePath, 'preserve-existing-keystore')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runPrepare(fixture)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the configured password and alias/i)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'preserve-existing-keystore')
})

test('accepts explicit signing values without Secret Service', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(keystorePath, 'synthetic-existing-keystore')
  const keytoolOnly = path.join(path.dirname(fixture.keytoolCalls), 'keytool-only')
  fs.mkdirSync(keytoolOnly)
  fs.symlinkSync(path.join(fixture.bin, 'keytool'), path.join(keytoolOnly, 'keytool'))

  const result = runPrepare(fixture, {
    PATH: `${keytoolOnly}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ANDROID_KEYSTORE_PATH: keystorePath,
    ANDROID_KEYSTORE_PASSWORD: 'synthetic-store-password',
    ANDROID_KEY_ALIAS: 'synthetic-release-alias',
    ANDROID_KEY_PASSWORD: 'synthetic-key-password',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
})

test('fails clearly when signing values are missing and Secret Service is unavailable', (t) => {
  const fixture = createFixture(t)
  const result = runPrepare(fixture, {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Linux Secret Service is required/i)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
})
