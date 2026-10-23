/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- node:test and deterministic fetch doubles intentionally use unawaited promises */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EtagMismatch } from 'pmtiles'

import { createPmtilesHttpSource } from './httpSource.ts'

const response = (
  body: Uint8Array<ArrayBuffer>,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(body, {
    status: init.status ?? 206,
    headers: init.headers,
  })

test('accepts an exact 206 range and validates Content-Range', async () => {
  const data = Uint8Array.from([1, 2, 3, 4])
  const requests: Request[] = []
  const source = createPmtilesHttpSource({
    url: 'https://example.invalid/world.pmtiles',
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return response(data, {
        headers: {
          'content-range': 'bytes 10-13/100',
          etag: '"archive-v1"',
          'cache-control': 'max-age=60',
        },
      })
    },
  })
  const result = await source.getBytes(10, 4)
  assert.deepEqual(new Uint8Array(result.data), data)
  assert.equal(result.etag, '"archive-v1"')
  assert.equal(result.cacheControl, 'max-age=60')
  assert.equal(requests[0]?.headers.get('range'), 'bytes=10-13')
})

test('rejects a full 200 response that ignored the range request', async () => {
  const source = createPmtilesHttpSource({
    url: 'https://example.invalid/world.pmtiles',
    fetch: async () =>
      response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-length': '100' },
      }),
  })
  await assert.rejects(() => source.getBytes(10, 4), /ignored the byte-range request/)
})

test('rejects mismatched Content-Range and short responses', async () => {
  const mismatched = createPmtilesHttpSource({
    url: 'https://example.invalid/world.pmtiles',
    fetch: async () =>
      response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { 'content-range': 'bytes 20-23/100' },
      }),
  })
  await assert.rejects(() => mismatched.getBytes(10, 4), /different byte range/)

  const short = createPmtilesHttpSource({
    url: 'https://example.invalid/world.pmtiles',
    fetch: async () => response(Uint8Array.from([1, 2]), { headers: {} }),
  })
  await assert.rejects(() => short.getBytes(10, 4), /returned 2 bytes/)
})

test('throws EtagMismatch when the server returns a different ETag', async () => {
  const source = createPmtilesHttpSource({
    url: 'https://example.invalid/world.pmtiles',
    fetch: async () =>
      response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { etag: '"archive-v2"', 'content-range': 'bytes 10-13/100' },
      }),
  })
  await assert.rejects(() => source.getBytes(10, 4, undefined, '"archive-v1"'), EtagMismatch)
})

test('passes abort signals to fetch', async () => {
  const controller = new AbortController()
  const source = createPmtilesHttpSource({
    url: 'https://example.invalid/world.pmtiles',
    fetch: async (_input, init) => {
      assert.equal(init?.signal, controller.signal)
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    },
  })
  await assert.rejects(
    () => source.getBytes(10, 4, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
})
