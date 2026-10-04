import assert from 'node:assert/strict'
import test from 'node:test'
import { createAndroidBackgroundSharing } from '../android/backgroundSharing.ts'
import {
  createSharingDiagnostics,
  diagnosticResult,
  summarizeDiagnostics,
} from './sharingDiagnostics.ts'

test('unpaired and unsupported checks are skipped without creating a sharing session', async () => {
  let created = false
  const suite = createSharingDiagnostics({
    shareBaseUrl: 'https://example.test/',
    createSession: () => {
      created = true
      throw new Error('Unexpected session')
    },
    capabilities: () => ({ secureContext: true, crypto: true, webRTC: true }),
    pairing: () => ({ role: 'none', url: '' }),
    invitation: () => undefined,
    stage: () => undefined,
  })
  const results = await suite.run('paired', new AbortController().signal, () => undefined)
  assert.equal(created, false)
  assert.equal(results.length, 3)
  assert.equal(summarizeDiagnostics(results).skipped, 3)
  assert.equal(summarizeDiagnostics(results).passed, 0)
})

test('diagnostic reports contain controlled outcomes and exclude arbitrary errors and details', () => {
  const result = diagnosticResult(
    {
      name: 'pair.lifecycle',
      ok: false,
      modelBased: false,
      error: {
        message: 'private-peer /ip4/10.0.0.1 #share=private-secret 40.123,20.234',
        stack: '/workspace/private',
      },
      details: { url: 'https://example.test/#share=private-secret' },
    },
    25,
    false,
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'check-failed')
  assert.equal(JSON.stringify(result).includes('private'), false)
  const cancelled = diagnosticResult(
    { name: 'pair.lifecycle', ok: false, modelBased: false },
    25,
    true,
  )
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(summarizeDiagnostics([cancelled]).passed, 0)
})

test('skipped diagnostic details cannot expose arbitrary peer information', () => {
  const result = diagnosticResult(
    {
      name: 'paired.lifecycle',
      ok: true,
      modelBased: false,
      details: { skipped: true, reason: 'private-peer #share=private-secret' },
    },
    0,
    false,
  )
  assert.equal(result.status, 'skipped')
  assert.equal(result.code, 'prerequisite-unavailable')
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('native real-location checks do not invoke the bridge without explicit consent', async () => {
  let invoked = false
  const native = createAndroidBackgroundSharing({
    isAndroid: true,
    now: () => 0,
    invoke: async () => {
      invoked = true
      throw new Error('Unexpected native invocation')
    },
  })!
  const suite = createSharingDiagnostics({
    shareBaseUrl: 'https://example.test/',
    native,
    nativeConsent: () => false,
    createSession: () => {
      throw new Error('Unexpected session')
    },
    capabilities: () => ({ secureContext: true, crypto: true, webRTC: true }),
    pairing: () => ({ role: 'host', url: '' }),
    invitation: () => undefined,
    stage: () => undefined,
  })
  const results = await suite.run(
    'android.background',
    new AbortController().signal,
    () => undefined,
  )
  assert.equal(invoked, false)
  assert.equal(results[0]?.status, 'skipped')
  assert.equal(results[0]?.code, 'real-location-consent-required')
})
