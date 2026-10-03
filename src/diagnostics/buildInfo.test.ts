import assert from 'node:assert/strict'
import test from 'node:test'

import { createDiagnosticSections, formatDiagnosticReport } from './buildInfo.ts'

test('diagnostics include the build timestamp in UTC and local time', () => {
  const sections = createDiagnosticSections(
    {
      version: '0.1.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-10-03T21:00:00.000Z',
    },
    {
      runtime: 'Web browser',
      userAgent: 'Synthetic browser 1.0',
      appVersion: 'Synthetic app version',
      platform: 'Synthetic platform',
      mobile: 'No',
      language: 'en-US',
      timezone: 'America/Los_Angeles',
      screen: '1280 × 720',
      viewport: '800 × 600 at 1.5×',
      online: 'Online',
      secureContext: 'Yes',
      capabilities: 'WebAssembly: Yes; WebRTC: Yes',
    },
  )

  assert.deepEqual(sections[0]?.items, [
    { label: 'Version', value: '0.1.0' },
    { label: 'Commit', value: 'a'.repeat(40) },
    { label: 'Built (UTC)', value: '2026-10-03T21:00:00.000Z' },
    { label: 'Built (local)', value: 'Oct 3, 2026, 2:00:00 PM PDT' },
  ])
})

test('diagnostics copy contains only build and browser environment sections', () => {
  const sections = createDiagnosticSections(
    { version: '0.1.0', commit: 'abc123', builtAt: '2026-10-03T21:00:00.000Z' },
    {
      runtime: 'Web browser',
      userAgent: 'Synthetic browser 1.0',
      appVersion: 'Synthetic app version',
      platform: 'Synthetic platform',
      mobile: 'No',
      language: 'en-US',
      timezone: 'UTC',
      screen: '1280 × 720',
      viewport: '800 × 600 at 1.5×',
      online: 'Online',
      secureContext: 'Yes',
      capabilities: 'WebAssembly: Yes; WebRTC: Yes',
    },
  )

  const report = formatDiagnosticReport(sections)

  assert.match(report, /Constellation build/)
  assert.match(report, /Browser environment/)
  assert.match(report, /User agent: Synthetic browser 1\.0/)
  assert.doesNotMatch(report, /share link|peer ID|location coordinates/i)
})
