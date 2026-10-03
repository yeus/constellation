import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const githubRepository = 'yeus/constellation'

const request = (runGh, endpoint, paginate = false) =>
  runGh([
    'api',
    `repos/${githubRepository}/actions/${endpoint}`,
    '--hostname',
    'github.com',
    ...(paginate ? ['--paginate', '--slurp'] : []),
  ])
const readJson = (runGh, endpoint, paginate = false) =>
  JSON.parse(request(runGh, endpoint, paginate))

const atomicWrite = (destination, contents) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 })
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

const parseRunId = (argv) => {
  if (argv.length > 1) throw new Error('Usage: scripts/download-ci-logs.sh [RUN_ID_OR_URL]')
  if (argv.length === 0) return undefined
  const match = argv[0].match(
    /^https:\/\/github\.com\/yeus\/constellation\/actions\/runs\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/,
  )
  const id = match?.[1] ?? argv[0]
  if (!/^\d+$/.test(id)) throw new Error('Expected a Constellation Actions run ID or URL.')
  return id
}

const captureJob = ({ runId, attempt, job, directory, runGh, report }) => {
  if (job.conclusion === 'skipped') {
    report(`  ${job.name}: skipped; no log expected.`)
    return { jobId: job.id, status: 'skipped' }
  }
  const label = job.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const file = `${job.id}-${label || 'job'}.log`
  try {
    const raw = runGh([
      'run',
      'view',
      String(runId),
      '--repo',
      githubRepository,
      '--job',
      String(job.id),
      '--attempt',
      String(attempt),
      '--log',
    ])
    if (raw.length === 0) throw new Error('Empty job log')
    atomicWrite(path.join(directory, file), raw)
    report(`  ${job.name}: saved ${file}`)
    return { jobId: job.id, status: 'saved', file }
  } catch {
    report(`  ${job.name}: log unavailable or download failed; previous file preserved.`)
    return { jobId: job.id, status: 'unavailable' }
  }
}

const captureRun = ({ record, output, runGh, report }) => {
  if (record.status !== 'completed') throw new Error('The selected run is not completed.')
  const attempt = record.run_attempt
  const endpoint = `runs/${record.id}/attempts/${attempt}`
  const pinned = readJson(runGh, endpoint)
  if (pinned.status !== 'completed') throw new Error('The selected attempt is not completed.')
  const jobs = readJson(runGh, `${endpoint}/jobs?per_page=100`, true).flatMap((page) => page.jobs)
  const directory = path.join(
    output,
    String(record.workflow_id),
    String(record.id),
    `attempt-${attempt}`,
  )
  report(`${pinned.name}: run ${record.id}, attempt ${attempt} (${pinned.conclusion}).`)
  const downloads = jobs.map((job) =>
    captureJob({ runId: record.id, attempt, job, directory, runGh, report }),
  )
  atomicWrite(
    path.join(directory, 'run.json'),
    JSON.stringify({ ...pinned, jobs, downloads }, null, 2) + '\n',
  )
  return {
    workflowId: record.workflow_id,
    runId: record.id,
    attempt,
    status: 'captured',
    directory: path.relative(output, directory),
    downloads,
  }
}

const selectWorkflowRun = (workflow, runGh, report) => {
  const endpoint = `workflows/${workflow.id}/runs`
  const completed = readJson(runGh, `${endpoint}?status=completed&per_page=1`).workflow_runs[0]
  const latest = readJson(runGh, `${endpoint}?per_page=1`).workflow_runs[0]
  const activeRun =
    latest && latest.status !== 'completed'
      ? { id: latest.id, status: latest.status, url: latest.html_url }
      : undefined
  if (activeRun)
    report(
      `${workflow.name}: newer run ${activeRun.id} is ${activeRun.status}; full logs are not ready.`,
    )
  if (!completed) report(`${workflow.name}: no completed runs found.`)
  return { completed, activeRun }
}

const captureWorkflow = ({ workflow, runId, output, runGh, report }) => {
  try {
    const { completed, activeRun } = runId
      ? { completed: readJson(runGh, `runs/${runId}`) }
      : selectWorkflowRun(workflow, runGh, report)
    const result = completed
      ? captureRun({ record: completed, output, runGh, report })
      : { workflowId: workflow.id, status: 'no-completed-run', downloads: [] }
    return { name: workflow.name, ...result, ...(activeRun && { activeRun }) }
  } catch {
    report(`${workflow.name}: incomplete capture; could not read a completed run and its jobs.`)
    return { name: workflow.name, workflowId: workflow.id, status: 'failed', downloads: [] }
  }
}

export const downloadCiLogs = ({ argv, root, runGh, report }) => {
  const runId = parseRunId(argv)
  const output = path.join(root, '.ci-logs')
  const workflows = runId
    ? [{ id: undefined, name: `Run ${runId}` }]
    : readJson(runGh, 'workflows?per_page=100', true).flatMap((page) => page.workflows)
  if (!runId && workflows.length === 0)
    report('GitHub returned no workflows; check repository Actions settings.')
  const captures = workflows.map((workflow) =>
    captureWorkflow({ workflow, runId, output, runGh, report }),
  )
  const errors = captures.flatMap((capture) =>
    capture.status === 'failed'
      ? [capture.name]
      : capture.downloads
          .filter((job) => job.status === 'unavailable')
          .map((job) => `${capture.name}: job ${job.jobId}`),
  )
  const summary = {
    repository: githubRepository,
    workflows: captures,
    errors,
    logCount: captures
      .flatMap((capture) => capture.downloads)
      .filter((job) => job.status === 'saved').length,
  }
  atomicWrite(path.join(output, 'latest.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}

const runGh = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (result.error?.code === 'ENOENT')
    throw new Error("GitHub CLI 'gh' is required; install it and authenticate locally.")
  if (result.error || result.status !== 0)
    throw new Error(
      'GitHub request failed; check local gh authentication, Actions read access, and log retention.',
    )
  return result.stdout
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const argv = process.argv.slice(2)
    if (argv.includes('--help')) {
      console.log(
        'Usage: scripts/download-ci-logs.sh [RUN_ID_OR_URL]\nWithout an argument, capture the latest completed run of every GitHub workflow.',
      )
    } else {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      const summary = downloadCiLogs({ argv, root, runGh, report: console.log })
      console.log(
        `Saved ${summary.logCount} job logs; ${summary.workflows.length} workflows considered. See .ci-logs/latest.json.`,
      )
      if (summary.errors.length) {
        console.error(
          `Incomplete downloads: ${summary.errors.length}. Check the summary and retry.`,
        )
        process.exitCode = 1
      }
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
