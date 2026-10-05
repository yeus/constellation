import assert from 'node:assert/strict'
import test from 'node:test'

import { streamToDuplex, type Libp2pStreamLike } from './stream.ts'

test('backpressure waits for drain without resending accepted bytes', async () => {
  const events: string[] = []
  const stream: Libp2pStreamLike = {
    async *[Symbol.asyncIterator]() {},
    send: (bytes) => {
      events.push(`send:${new TextDecoder().decode(bytes.subarray())}`)
      return events.length !== 1
    },
    onDrain: async () => {
      events.push('drain')
    },
    close: async () => {
      events.push('close')
    },
  }
  const chunks = [new TextEncoder().encode('first'), new TextEncoder().encode('last')]
  await streamToDuplex(stream).sink(chunks)
  assert.deepEqual(events, ['send:first', 'drain', 'send:last', 'close'])
})
