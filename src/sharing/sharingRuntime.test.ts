import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserLocationSource } from '../location/browser.ts'
import {
  createSharingRuntime,
  generatedFollowName,
  rememberRedeemedNonce,
  savedFollowRecords,
} from './sharingRuntime.ts'

test('bounds remembered redemption nonces and preserves recent entries', () => {
  const nonces = new Set<string>()

  rememberRedeemedNonce(nonces, 'first', 2)
  rememberRedeemedNonce(nonces, 'second', 2)
  rememberRedeemedNonce(nonces, 'third', 2)

  assert.deepEqual([...nonces], ['second', 'third'])
})

test('temporary previews are excluded from the private saved-follow snapshot', () => {
  const records = savedFollowRecords([
    { url: 'https://example.test/#one', localName: 'River', color: '#438ec9', saved: false },
    { url: 'https://example.test/#two', localName: 'Forest', color: '#8a6fc9', saved: true },
  ])
  assert.deepEqual(records, [
    { url: 'https://example.test/#two', localName: 'Forest', color: '#8a6fc9' },
  ])
})

test('generated names are stable for a share and do not expose its identifier', () => {
  const name = generatedFollowName('private-share-123')
  assert.equal(generatedFollowName('private-share-123'), name)
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/)
  assert.equal(name.includes('123'), false)
})

test('unavailable protected storage leaves temporary previews possible', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  try {
    for (const failure of ['load', 'save'] as const) {
      const source = createBrowserLocationSource({ sourceId: 'synthetic', geolocation: undefined })
      const runtime = createSharingRuntime(source, 'https://example.test/', {
        load: async () => {
          if (failure === 'load') throw new Error('Synthetic keyring unavailable.')
          return undefined
        },
        save: async () => {
          if (failure === 'save') throw new Error('Synthetic keyring unavailable.')
        },
      })
      try {
        await runtime.initialize()
        let message = ''
        runtime.subscribe((state) => {
          message = state.message
        })()
        assert.match(message, /preview only/i)
      } finally {
        await runtime.stop()
      }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
