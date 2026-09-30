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
if (process.argv[2] === 'search') {
  if (process.env.CONSTELLATION_TEST_SECRET_UNAVAILABLE === '1') process.exit(1)
  const retryMarker = process.env.CONSTELLATION_TEST_SECRET_RETRY_MARKER
  if (retryMarker && !fs.existsSync(retryMarker)) {
    fs.writeFileSync(retryMarker, '')
    process.exit(1)
  }
  process.exit(0)
} else if (process.argv[2] === 'lookup') {
  if (process.env.CONSTELLATION_TEST_DENIED_SECRET === key) {
    process.stderr.write('access denied')
    process.exit(1)
  }
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
const option = (name) => {
  const index = args.indexOf(name)
  const value = args[index + 1]
  return name.endsWith(':env') ? process.env[value] : value
}
fs.appendFileSync(process.env.CONSTELLATION_TEST_KEYTOOL_CALLS, args[0] + '\\n')
if (args[0] === '-genkeypair') {
  if (!option('-storepass:env') || !option('-keypass:env')) process.exit(2)
  if (args.includes('-storepass') || args.includes('-keypass')) process.exit(2)
  fs.writeFileSync(option('-keystore'), 'synthetic-generated-keystore')
  process.exit(0)
}
if (args[0] === '-list') {
  const contents = fs.readFileSync(option('-keystore'), 'utf8')
  if (!contents.startsWith('synthetic-')) process.exit(1)
  process.stdout.write(
    'Keystore type: JKS\\nAlias name: ' +
      (process.env.ANDROID_KEY_ALIAS || 'constellation-release-key') +
      '\\nEntry type: PrivateKeyEntry\\n',
  )
  process.exit(0)
}
if (args[0] === '-certreq') {
  const contents = fs.readFileSync(option('-keystore'), 'utf8')
  process.exit(contents.startsWith('synthetic-') && option('-keypass:env') !== 'wrong-key-password' ? 0 : 1)
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

const runPrepare = (fixture, environment = {}, interactive = false, input = '') =>
  spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$1"; prepare_constellation_android_signing build "$2"',
      'test',
      path.join(projectRoot, 'scripts/android-release-secrets.sh'),
      interactive ? '1' : '0',
    ],
    { encoding: 'utf8', env: { ...fixture.env, ...environment }, input },
  )

const runRestore = (fixture, environment = {}) =>
  spawnSync('bash', [path.join(projectRoot, 'scripts/restore-android-keystore.sh')], {
    encoding: 'utf8',
    env: { ...fixture.env, ...environment },
  })

test('creates missing signing credentials and persists them to Secret Service', (t) => {
  const fixture = createFixture(t)
  const result = runPrepare(fixture, {}, true, 'CREATE\n')
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
    '-certreq',
    '-list',
    '-certreq',
  ])
})

test('rejects a wrong key password before Gradle packaging', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(keystorePath, 'synthetic-existing-keystore')

  const result = runPrepare(fixture, {
    ANDROID_KEYSTORE_PATH: keystorePath,
    ANDROID_KEYSTORE_PASSWORD: 'synthetic-store-password',
    ANDROID_KEY_ALIAS: 'synthetic-release-alias',
    ANDROID_KEY_PASSWORD: 'wrong-key-password',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /android_key_password could not unlock/i)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-existing-keystore')
})

test('reports a missing keytool before blaming the stored password', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(keystorePath, 'synthetic-existing-keystore')
  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; PATH=/nonexistent; prepare_constellation_android_signing build 0',
      'test',
      path.join(projectRoot, 'scripts/android-release-secrets.sh'),
    ],
    {
      encoding: 'utf8',
      env: {
        ...fixture.env,
        ANDROID_KEYSTORE_PATH: keystorePath,
        ANDROID_KEYSTORE_PASSWORD: 'synthetic-store-password',
        ANDROID_KEY_ALIAS: 'synthetic-release-alias',
        ANDROID_KEY_PASSWORD: 'synthetic-key-password',
      },
    },
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /keytool.*not.*PATH/i)
  assert.match(result.stderr, /nix develop/i)
  assert.doesNotMatch(result.stderr, /android_keystore_password could not open/i)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
})

test('does not invent a key password for an existing keystore', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true })
  fs.writeFileSync(keystorePath, 'synthetic-existing-keystore')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
    }),
  )

  const result = runPrepare(fixture)
  const stored = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /key password.*missing/i)
  assert.equal(stored.android_key_password, undefined)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-existing-keystore')
})

test('does not invent a keystore password for an existing keystore', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true })
  fs.writeFileSync(keystorePath, 'synthetic-existing-keystore')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runPrepare(fixture)
  const stored = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /keystore password.*missing/i)
  assert.equal(stored.android_keystore_password, undefined)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-existing-keystore')
})

test('does not replace a password when its Secret Service lookup is denied', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true })
  fs.writeFileSync(keystorePath, 'synthetic-existing-keystore')
  const stored = {
    android_keystore_path: keystorePath,
    android_keystore_password: 'synthetic-store-password',
    android_key_alias: 'synthetic-release-alias',
    android_key_password: 'synthetic-original-key-password',
  }
  fs.writeFileSync(fixture.storePath, JSON.stringify(stored))

  const result = runPrepare(fixture, {
    CONSTELLATION_TEST_DENIED_SECRET: 'android_key_password',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /could not read android signing entry android_key_password/i)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), stored)
})

test('release preparation uses the stored backup without restoring a missing local keystore', (t) => {
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

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /backup.*android_keystore_base64/i)
  assert.equal(fs.existsSync(expectedPath), false)
})

test('explicit restore validates the backup before creating the local keystore', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_base64: Buffer.from('synthetic-restored-keystore').toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runRestore(fixture)

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-restored-keystore')
  assert.equal(fs.statSync(keystorePath).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(fixture.keytoolCalls, 'utf8'), /^-list\n-certreq\n/)
})

test('explicit restore rejects a backup that cannot be opened and preserves the local file', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(keystorePath, 'preserve-existing-keystore')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_base64: Buffer.from('invalid-backup').toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runRestore(fixture)

  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'preserve-existing-keystore')
  assert.deepEqual(
    JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')).android_keystore_base64,
    Buffer.from('invalid-backup').toString('base64'),
  )
})

test('explicit restore preserves the old local keystore after a valid backup replaces it', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(keystorePath, 'preserve-existing-keystore')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_base64: Buffer.from('synthetic-restored-keystore').toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runRestore(fixture)
  const backupPath = result.stderr.match(/Previous local keystore saved at: (.+)/)?.[1]

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.ok(backupPath)
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'preserve-existing-keystore')
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-restored-keystore')
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
  assert.match(result.stderr, /android_keystore_password could not open/i)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'preserve-existing-keystore')
})

test('prefers a valid backup over a mismatched local file without replacing it', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_base64: Buffer.from('synthetic-valid-backup').toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )
  fs.writeFileSync(keystorePath, 'preserve-existing-keystore')

  const result = runPrepare(fixture)

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /backup android_keystore_base64 validates/i)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'preserve-existing-keystore')
})

test('refuses to choose between two different valid signing keystores', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  fs.writeFileSync(keystorePath, 'synthetic-local-key')
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_base64: Buffer.from('synthetic-backup-key').toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runPrepare(fixture)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /two valid.*different|both.*valid.*different/i)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'synthetic-local-key')
})

test('reports identical failing local and backup files and the password source', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.home, 'release.jks')
  const original = 'invalid-keystore'
  fs.writeFileSync(keystorePath, original)
  fs.writeFileSync(
    fixture.storePath,
    JSON.stringify({
      android_keystore_path: keystorePath,
      android_keystore_base64: Buffer.from(original).toString('base64'),
      android_keystore_password: 'synthetic-store-password',
      android_key_alias: 'synthetic-release-alias',
      android_key_password: 'synthetic-key-password',
    }),
  )

  const result = runPrepare(fixture, {
    ANDROID_KEYSTORE_PASSWORD: 'environment-override',
    ANDROID_KEYSTORE_BASE64: Buffer.from(original).toString('base64'),
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /password source: ANDROID_KEYSTORE_PASSWORD environment variable/i)
  assert.match(result.stderr, /backup source: ANDROID_KEYSTORE_BASE64 environment variable/i)
  assert.match(result.stderr, /local file and backup are byte-for-byte identical/i)
  assert.equal(result.stderr.includes('environment-override'), false)
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), original)
  assert.equal(
    JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')).android_keystore_password,
    'synthetic-store-password',
  )
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

test('accepts explicit base64 signing values without Secret Service or local file', (t) => {
  const fixture = createFixture(t)
  const keytoolOnly = path.join(path.dirname(fixture.keytoolCalls), 'keytool-only')
  fs.mkdirSync(keytoolOnly)
  fs.symlinkSync(path.join(fixture.bin, 'keytool'), path.join(keytoolOnly, 'keytool'))
  const result = runPrepare(fixture, {
    PATH: `${keytoolOnly}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ANDROID_KEYSTORE_BASE64: Buffer.from('synthetic-remote-keystore').toString('base64'),
    ANDROID_KEYSTORE_PASSWORD: 'synthetic-store-password',
    ANDROID_KEY_ALIAS: 'synthetic-release-alias',
    ANDROID_KEY_PASSWORD: 'synthetic-key-password',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
})

test('fails clearly when signing values are missing and Secret Service is unavailable', (t) => {
  const fixture = createFixture(t)
  const keytoolOnly = path.join(fixture.home, 'keytool-only')
  fs.mkdirSync(keytoolOnly)
  fs.symlinkSync(path.join(fixture.bin, 'keytool'), path.join(keytoolOnly, 'keytool'))
  const result = runPrepare(fixture, {
    PATH: `${keytoolOnly}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Linux Secret Service is required/i)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
})

test('does not create credentials when Secret Service cannot be reached', (t) => {
  const fixture = createFixture(t)
  const result = runPrepare(fixture, {
    CONSTELLATION_TEST_SECRET_UNAVAILABLE: '1',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Secret Service.*unavailable|unlock/i)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
  assert.equal(fs.existsSync(path.join(fixture.config, 'constellation/android-release.jks')), false)
})

test('does not silently create a fresh identity without interactive confirmation', (t) => {
  const fixture = createFixture(t)
  const result = runPrepare(fixture)

  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /new signing identity.*interactive|interactive.*new signing identity/i,
  )
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
  assert.equal(fs.existsSync(path.join(fixture.config, 'constellation/android-release.jks')), false)
})

test('retries an unavailable Secret Service before offering a fresh identity', (t) => {
  const fixture = createFixture(t)
  const retryMarker = path.join(fixture.home, 'secret-service-retried')
  const result = runPrepare(
    fixture,
    { CONSTELLATION_TEST_SECRET_RETRY_MARKER: retryMarker },
    true,
    '\nCREATE\n',
  )

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /unlock.*retry/i)
  assert.equal(fs.existsSync(retryMarker), true)
  assert.equal(
    typeof JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')).android_keystore_base64,
    'string',
  )
})

test('rejects new identity setup when an existing local keystore is present', (t) => {
  const fixture = createFixture(t)
  const keystorePath = path.join(fixture.config, 'constellation/android-release.jks')
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true })
  fs.writeFileSync(keystorePath, 'existing-signing-key')

  const result = runPrepare(fixture, {}, true, 'CREATE\n')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /existing.*keystore|existing.*identity/i)
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.storePath, 'utf8')), {})
  assert.equal(fs.readFileSync(keystorePath, 'utf8'), 'existing-signing-key')
})
