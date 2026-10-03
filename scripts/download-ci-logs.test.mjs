import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { downloadCiLogs } from './download-ci-logs.mjs'

const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'constellation-ci-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const replies = new Map()
  const calls = []
  const runGh = (args) => {
    if (args[0] === 'run') {
      const job = args[args.indexOf('--job') + 1]
      const attempt = args[args.indexOf('--attempt') + 1]
      const endpoint = `run-view/${args[2]}/attempt/${attempt}/job/${job}`
      calls.push({ endpoint, args })
      assert.ok(replies.has(endpoint), `Unexpected request: ${endpoint}`)
      const reply = replies.get(endpoint)
      if (reply instanceof Error) throw reply
      return typeof reply === 'string' ? reply : JSON.stringify(reply)
    }
    assert.equal(args[0], 'api')
    const endpoint = args[1].replace('repos/yeus/constellation/actions/', '')
    calls.push({ endpoint, args })
    assert.ok(replies.has(endpoint), `Unexpected request: ${endpoint}`)
    const reply = replies.get(endpoint)
    if (reply instanceof Error) throw reply
    return typeof reply === 'string' ? reply : JSON.stringify(reply)
  }
  return { root, replies, calls, runGh }
}

const run = (id, workflow = 1, attempt = 1) => ({
  id,
  workflow_id: workflow,
  run_attempt: attempt,
  name: 'Synthetic workflow',
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/yeus/constellation/actions/runs/${id}`,
})

const addRun = (replies, record, jobs = [{ id: 71, name: 'Build', conclusion: 'success' }]) => {
  replies.set(`runs/${record.id}/attempts/${record.run_attempt}`, record)
  replies.set(`runs/${record.id}/attempts/${record.run_attempt}/jobs?per_page=100`, [{ jobs }])
  for (const job of jobs) {
    replies.set(
      `run-view/${record.id}/attempt/${record.run_attempt}/job/${job.id}`,
      `Raw full job ${job.id}\n`,
    )
  }
}

test('downloads latest completed runs of all paginated workflows and reports active runs', (t) => {
  const { root, replies, calls, runGh } = fixture(t)
  replies.set('workflows?per_page=100', [
    {
      workflows: [
        { id: 1, name: 'Renamed checks' },
        { id: 2, name: 'Apps' },
      ],
    },
    {
      workflows: [
        { id: 3, name: 'CodeQL' },
        { id: 4, name: 'Never run' },
      ],
    },
  ])
  for (const id of [1, 2, 3, 4]) {
    const record = run(id * 10, id, 2)
    record.conclusion = id === 2 ? 'failure' : 'success'
    replies.set(`workflows/${id}/runs?status=completed&per_page=1`, {
      workflow_runs: id === 4 ? [] : [record],
    })
    replies.set(`workflows/${id}/runs?per_page=1`, {
      workflow_runs:
        id === 1
          ? [{ ...record, id: 11, status: 'in_progress' }]
          : id === 4
            ? [{ ...record, status: 'queued' }]
            : [record],
    })
    if (id !== 4)
      addRun(replies, record, [
        { id: id * 100, name: 'Build / ../../apps', conclusion: id === 2 ? 'failure' : 'success' },
        { id: id * 100 + 1, name: 'Skipped', conclusion: 'skipped' },
      ])
  }
  const summary = downloadCiLogs({ argv: [], root, runGh, report: () => {} })
  assert.equal(summary.errors.length, 0)
  assert.equal(summary.logCount, 3)
  assert.equal(summary.workflows.length, 4)
  assert.equal(summary.workflows[0].activeRun.id, 11)
  assert.equal(summary.workflows[3].status, 'no-completed-run')
  for (const id of [1, 2, 3]) {
    const directory = path.join(root, '.ci-logs', String(id), String(id * 10), 'attempt-2')
    const logs = fs.readdirSync(directory).filter((name) => name.endsWith('.log'))
    assert.equal(logs.length, 1)
    assert.match(fs.readFileSync(path.join(directory, logs[0]), 'utf8'), /^Raw full job/)
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'run.json'), 'utf8'))
    assert.equal(metadata.jobs.length, 2)
    assert.equal(metadata.downloads[1].status, 'skipped')
  }
  assert.ok(
    calls
      .filter(({ endpoint }) => endpoint.includes('per_page=100'))
      .every(({ args }) => args.includes('--paginate') && args.includes('--slurp')),
  )
  const jobLogCalls = calls.filter(({ args }) => args[0] === 'run')
  assert.equal(jobLogCalls.length, 3)
  assert.ok(
    jobLogCalls.every(({ args }) =>
      ['--job', '--attempt', '--log', '--repo'].every((flag) => args.includes(flag)),
    ),
  )
})

test('job pagination includes successful and failed jobs from every page', (t) => {
  const { root, replies, runGh } = fixture(t)
  const record = run(42)
  replies.set('runs/42', record)
  const jobs = [
    { id: 71, name: 'Build', conclusion: 'success' },
    { id: 72, name: 'Tests', conclusion: 'failure' },
  ]
  addRun(replies, record, jobs)
  replies.set('runs/42/attempts/1/jobs?per_page=100', [{ jobs: [jobs[0]] }, { jobs: [jobs[1]] }])
  const summary = downloadCiLogs({ argv: ['42'], root, runGh, report: () => {} })
  assert.equal(summary.logCount, 2)
  assert.deepEqual(
    summary.workflows[0].downloads.map((job) => job.jobId),
    [71, 72],
  )
})

test('explicit run URL pins its attempt, refreshes logs, and preserves older captures', (t) => {
  const { root, replies, runGh } = fixture(t)
  const record = run(42, 9, 3)
  replies.set('runs/42', record)
  addRun(replies, record)
  const invoke = () =>
    downloadCiLogs({
      argv: ['https://github.com/yeus/constellation/actions/runs/42?check_suite_focus=true'],
      root,
      runGh,
      report: () => {},
    })
  const old = path.join(root, '.ci-logs', 'old.log')
  fs.mkdirSync(path.dirname(old))
  fs.writeFileSync(old, 'preserve')
  invoke()
  replies.set('run-view/42/attempt/3/job/71', 'Refreshed raw output\n')
  invoke()
  const log = path.join(root, '.ci-logs', '9', '42', 'attempt-3', '71-build.log')
  assert.equal(fs.readFileSync(log, 'utf8'), 'Refreshed raw output\n')
  assert.equal(fs.statSync(log).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(old, 'utf8'), 'preserve')
})

test('a missing job log preserves the previous file and other jobs still download', (t) => {
  const { root, replies, runGh } = fixture(t)
  const record = run(42)
  replies.set('runs/42', record)
  addRun(replies, record, [
    { id: 71, name: 'Build', conclusion: 'success' },
    { id: 72, name: 'Tests', conclusion: 'failure' },
  ])
  const invoke = () => downloadCiLogs({ argv: ['42'], root, runGh, report: () => {} })
  invoke()
  replies.set('run-view/42/attempt/1/job/71', new Error('expired logs'))
  replies.set('run-view/42/attempt/1/job/72', 'New test logs\n')
  const summary = invoke()
  assert.equal(summary.errors.length, 1)
  assert.equal(summary.logCount, 1)
  const directory = path.join(root, '.ci-logs', '1', '42', 'attempt-1')
  assert.equal(fs.readFileSync(path.join(directory, '71-build.log'), 'utf8'), 'Raw full job 71\n')
  assert.equal(fs.readFileSync(path.join(directory, '72-tests.log'), 'utf8'), 'New test logs\n')
  assert.equal(
    fs.readdirSync(directory).some((name) => name.endsWith('.tmp')),
    false,
  )
})

test('workflow failures do not prevent remaining workflows from being captured', (t) => {
  const { root, replies, runGh } = fixture(t)
  replies.set('workflows?per_page=100', [
    {
      workflows: [
        { id: 1, name: 'Checks' },
        { id: 2, name: 'Apps' },
      ],
    },
  ])
  replies.set('workflows/1/runs?status=completed&per_page=1', new Error('not accessible'))
  replies.set('workflows/2/runs?status=completed&per_page=1', { workflow_runs: [run(20, 2)] })
  replies.set('workflows/2/runs?per_page=1', { workflow_runs: [run(20, 2)] })
  addRun(replies, run(20, 2))
  const summary = downloadCiLogs({ argv: [], root, runGh, report: () => {} })
  assert.equal(summary.errors.length, 1)
  assert.equal(summary.logCount, 1)
})

test('rejects foreign URLs, extra arguments, active runs, and discovery failures', (t) => {
  const { root, replies, runGh } = fixture(t)
  for (const argv of [
    ['42', '43'],
    ['https://github.com/other/project/actions/runs/42'],
    ['../42'],
  ]) {
    assert.throws(() => downloadCiLogs({ argv, root, runGh, report: () => {} }))
  }
  replies.set('runs/42', { ...run(42), status: 'in_progress' })
  assert.equal(downloadCiLogs({ argv: ['42'], root, runGh, report: () => {} }).errors.length, 1)
  replies.set('workflows?per_page=100', new Error('authentication required'))
  assert.throws(() => downloadCiLogs({ argv: [], root, runGh, report: () => {} }))
})

test('CLI uses a fake gh executable and returns nonzero for partial downloads', (t) => {
  const { root } = fixture(t)
  const fakeGh = path.join(root, 'gh')
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const endpoint = process.argv[3]
if (endpoint.endsWith('/runs/42') || endpoint.endsWith('/runs/42/attempts/1')) {
  console.log(JSON.stringify(${JSON.stringify(run(42))}))
} else if (endpoint.includes('/jobs?')) {
  console.log(JSON.stringify([{jobs: [{id: 71, name: 'Build', conclusion: 'failure'}]}]))
} else {
  process.exitCode = 1
}
`,
    { mode: 0o700 },
  )
  const entrypoint = path.join(root, 'scripts', 'download-ci-logs.mjs')
  fs.mkdirSync(path.dirname(entrypoint))
  fs.copyFileSync('scripts/download-ci-logs.mjs', entrypoint)
  const result = spawnSync(process.execPath, [entrypoint, '42'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /0 job logs/)
  assert.match(result.stderr, /incomplete/i)
})
