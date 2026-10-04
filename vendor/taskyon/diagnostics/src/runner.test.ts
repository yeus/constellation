import assert from 'node:assert/strict'
import test from 'node:test'
import { runDiagnosticsTests, getDiagnosticsSkipReason } from './index.ts'

test('cancels an active diagnostic and prevents later tests from running', async () => {
  const controller = new AbortController()
  let cancelled = false
  let nextRan = false
  const results = await runDiagnosticsTests(
    {
      active: (context) =>
        new Promise<void>((resolve) => {
          context?.abortSignal?.addEventListener(
            'abort',
            () => {
              cancelled = true
              resolve()
            },
            { once: true },
          )
          queueMicrotask(() => controller.abort())
        }),
      next: () => {
        nextRan = true
      },
    },
    { context: { abortSignal: controller.signal } },
  )
  assert.equal(cancelled, true)
  assert.equal(nextRan, false)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, false)
})

test('preserves skips and continues after a diagnostic failure', async () => {
  const results = await runDiagnosticsTests(
    {
      missing: () => ({ skipped: true, reason: 'Partner required.' }),
      broken: () => {
        throw new Error('Synthetic failure')
      },
      next: () => 'complete',
    },
    { details: true },
  )
  assert.equal(getDiagnosticsSkipReason(results[0]?.details), 'Partner required.')
  assert.equal(results[1]?.ok, false)
  assert.equal(results[2]?.details, 'complete')
})

test('prepared contexts retain the owning cancellation signal', async () => {
  const controller = new AbortController()
  let cancelled = false
  const results = await runDiagnosticsTests(
    {
      active: (context) =>
        new Promise<void>((resolve) => {
          context?.abortSignal?.addEventListener(
            'abort',
            () => {
              cancelled = true
              resolve()
            },
            { once: true },
          )
          queueMicrotask(() => controller.abort())
        }),
    },
    {
      context: { abortSignal: controller.signal },
      contextForTest: () => ({ model: 'synthetic' }),
      timeoutMs: 5,
    },
  )
  assert.equal(cancelled, true)
  assert.equal(results[0]?.ok, false)
})

test('cancellation from the start callback prevents the test body', async () => {
  const controller = new AbortController()
  let ran = false
  const results = await runDiagnosticsTests(
    {
      active: () => {
        ran = true
      },
    },
    {
      context: { abortSignal: controller.signal },
      onProgress: ({ phase }) => {
        if (phase === 'start') controller.abort()
      },
    },
  )
  assert.equal(ran, false)
  assert.equal(results[0]?.ok, false)
})

test('cancelling asynchronous setup prevents the diagnostic body', async () => {
  const controller = new AbortController()
  let ran = false
  const active = Object.assign(
    () => {
      ran = true
    },
    {
      setup: async () => {
        controller.abort()
      },
    },
  )
  const results = await runDiagnosticsTests(
    { active },
    { context: { abortSignal: controller.signal } },
  )
  assert.equal(ran, false)
  assert.equal(results[0]?.ok, false)
})
