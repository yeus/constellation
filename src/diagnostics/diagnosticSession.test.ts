import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiagnosticSession } from './diagnosticSession.ts'

test('an already cancelled session wait rejects even when its state matches', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
  const session = createDiagnosticSession('https://example.test/')
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      session.wait(() => true, controller.signal),
      /cancelled/,
    )
  } finally {
    await session.close()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
