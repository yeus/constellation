import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DebuggerTimeoutError,
  DebuggerTransportError,
  evaluateReadOnlyWithRecovery,
  readOnlyCdpOperation,
} from './android-debugger-recovery.mjs'

const readOnlyExpression = "window.__TAURI_INTERNALS__?.invoke('android_receiver_ownership')"

test('classifies read-only and state-changing WebView evaluations', () => {
  assert.equal(readOnlyCdpOperation(readOnlyExpression), 'android_receiver_ownership')
  assert.equal(readOnlyCdpOperation("invoke('android_start_background_share')"), undefined)
  assert.equal(readOnlyCdpOperation(undefined), undefined)
})

test('retries a read-only evaluation once after reconnecting the debugger', async () => {
  let reconnects = 0
  let attempts = 0
  const value = await evaluateReadOnlyWithRecovery({
    expression: readOnlyExpression,
    reconnect: async () => {
      reconnects += 1
    },
    evaluate: async () => {
      attempts += 1
      if (attempts === 1) throw new DebuggerTimeoutError('stalled')
      return 7
    },
  })
  assert.equal(value, 7)
  assert.equal(reconnects, 1)
  assert.equal(attempts, 2)
})

test('retries after a debugger disconnect, not only after a timeout', async () => {
  let reconnects = 0
  let attempts = 0
  await evaluateReadOnlyWithRecovery({
    expression: "document.querySelector('button')",
    reconnect: async () => {
      reconnects += 1
    },
    evaluate: async () => {
      attempts += 1
      if (attempts === 1) throw new DebuggerTransportError('disconnected')
      return true
    },
  })
  assert.equal(reconnects, 1)
})

test('never repeats a state-changing evaluation', async () => {
  let reconnects = 0
  await assert.rejects(
    evaluateReadOnlyWithRecovery({
      expression: "invoke('android_start_background_share')",
      reconnect: async () => {
        reconnects += 1
      },
      evaluate: async () => {
        throw new DebuggerTimeoutError('stalled')
      },
    }),
    /stalled/,
  )
  assert.equal(reconnects, 0)
})

test('leaves application errors untouched', async () => {
  let reconnects = 0
  await assert.rejects(
    evaluateReadOnlyWithRecovery({
      expression: readOnlyExpression,
      reconnect: async () => {
        reconnects += 1
      },
      evaluate: async () => {
        throw new Error('Location permission denied')
      },
    }),
    /Location permission denied/,
  )
  assert.equal(reconnects, 0)
})

test('stops after the configured retry budget', async () => {
  let reconnects = 0
  await assert.rejects(
    evaluateReadOnlyWithRecovery({
      expression: readOnlyExpression,
      reconnect: async () => {
        reconnects += 1
      },
      evaluate: async () => {
        throw new DebuggerTimeoutError('stalled')
      },
      retries: 2,
    }),
    /stalled/,
  )
  assert.equal(reconnects, 2)
})
