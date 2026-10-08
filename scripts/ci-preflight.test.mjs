import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./ci-preflight.mjs', import.meta.url))
const quality = [
  'install --immutable',
  'format:check',
  'build:vendor',
  'lint',
  'test',
  'test:android:config',
  'build',
  'release:check',
]
const browser = [
  'playwright test tests/share-flow.spec.ts --workers=1',
  'playwright test tests/p2p-share.spec.ts --project=desktop --workers=1',
  'playwright test tests/map-ui.spec.ts --workers=1',
  'playwright test tests/sharing-diagnostics.spec.ts --workers=1',
  'test:pages',
  'screenshots',
]

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-ci-'))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(root, '.gitignore'), '.screenshots/\nbin/\n')
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n')
  execFileSync('git', ['init', '--quiet', root])
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'tracked.txt'])
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=CI Fixture',
    '-c',
    'user.email=ci@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ])
  const fakeCorepack = path.join(bin, 'corepack')
  fs.writeFileSync(
    fakeCorepack,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CI_FIXTURE_LOG, args.join(' ') + '\\n')
if (args.includes('screenshots') && process.env.CI_FIXTURE_NO_SCREENSHOTS !== '1') {
  fs.mkdirSync('.screenshots', { recursive: true })
  fs.writeFileSync(path.join('.screenshots', 'synthetic.png'), 'fixture')
}
if (args.includes(process.env.CI_FIXTURE_FAIL_ON)) process.exit(7)
`,
    { mode: 0o755 },
  )
  return {
    root,
    log: path.join(bin, '.ci-commands'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}
const run = (fixture, mode, env = {}) =>
  spawnSync(process.execPath, [runner, mode], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      PATH: `${path.join(fixture.root, 'bin')}:${process.env.PATH}`,
      CI_FIXTURE_LOG: fixture.log,
    },
  })
const recorded = (fixture) =>
  fs.existsSync(fixture.log)
    ? fs.readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean)
    : []

test('quick runs the Quality commands in order without requiring a clean checkout', () => {
  const f = fixture()
  try {
    fs.appendFileSync(path.join(f.root, 'tracked.txt'), 'uncommitted\n')
    const result = run(f, 'quick')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      recorded(f),
      quality.map((command) => `yarn ${command}`),
    )
  } finally {
    f.cleanup()
  }
})

test('full preflight rejects dirty, staged and untracked changes before running checks', () => {
  for (const kind of ['unstaged', 'staged', 'untracked']) {
    const f = fixture()
    try {
      if (kind === 'untracked') fs.writeFileSync(path.join(f.root, 'untracked.txt'), 'fixture')
      else {
        fs.appendFileSync(path.join(f.root, 'tracked.txt'), 'change\n')
        if (kind === 'staged') execFileSync('git', ['-C', f.root, 'add', 'tracked.txt'])
      }
      const result = run(f, 'preflight')
      assert.notEqual(result.status, 0, kind)
      assert.match(result.stderr, /clean Git checkout/i)
      assert.deepEqual(recorded(f), [])
    } finally {
      f.cleanup()
    }
  }
})

test('full preflight runs Quality, browser, Pages, and screenshots on the commit', () => {
  const f = fixture()
  try {
    const result = run(f, 'preflight')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      recorded(f),
      [...quality, ...browser].map((command) => `yarn ${command}`),
    )
    assert.match(result.stdout, /Committed revision validated/)
  } finally {
    f.cleanup()
  }
})

test('preflight fails on a failed CI step or missing screenshot artifacts', () => {
  for (const env of [{ CI_FIXTURE_FAIL_ON: 'lint' }, { CI_FIXTURE_NO_SCREENSHOTS: '1' }]) {
    const f = fixture()
    try {
      const result = run(f, 'preflight', env)
      assert.notEqual(result.status, 0)
      assert.doesNotMatch(result.stdout, /Committed revision validated/)
      if (env.CI_FIXTURE_FAIL_ON) {
        assert.deepEqual(
          recorded(f),
          quality.slice(0, 4).map((command) => `yarn ${command}`),
        )
      } else {
        assert.match(result.stderr, /Screenshot/i)
      }
    } finally {
      f.cleanup()
    }
  }
})
