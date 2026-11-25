import assert from 'node:assert/strict'
import test from 'node:test'
import { probeMapSource } from './check-map-source.mjs'

const url = 'https://map.example.test/world.pmtiles'
const origin = 'https://app.example.test'
const header = Buffer.alloc(127)
header.write('PMTiles')
header[7] = 3

const response = (overrides = {}, body = header, status = 206) =>
  new Response(body, {
    status,
    headers: {
      'content-range': 'bytes 0-126/10000',
      'access-control-allow-origin': '*',
      ...overrides,
    },
  })

test('checks the real public PMTiles header using a bounded anonymous range and app origin', async () => {
  await probeMapSource(url, origin, async (address, options) => {
    assert.equal(address, url)
    assert.equal(new Headers(options.headers).get('range'), 'bytes=0-126')
    assert.equal(new Headers(options.headers).get('origin'), origin)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    return response()
  })
  await probeMapSource(url, origin, async () => response({ 'access-control-allow-origin': origin }))
})

test('rejects authorization and a server that ignores Range without consuming the full archive', async () => {
  for (const status of [401, 403, 200]) {
    const body = new ReadableStream({ pull() {}, cancel() {} })
    await assert.rejects(
      probeMapSource(url, origin, async () => new Response(body, { status })),
      new RegExp('HTTP ' + status),
    )
  }
})

test('rejects incorrect range, missing CORS permission, truncated or non-PMTiles payload', async () => {
  for (const [result, pattern] of [
    [response({ 'content-range': 'bytes 1-127/10000' }), /Content-Range/],
    [response({ 'content-range': 'bytes 0-126/126' }), /Content-Range/],
    [response({ 'access-control-allow-origin': 'https://another.example.test' }), /CORS/],
    [response({}, header.subarray(0, 8)), /127 bytes/],
    [response({}, Buffer.alloc(127)), /PMTiles v3/],
    [response({}, Buffer.alloc(128)), /127 bytes/],
  ]) {
    await assert.rejects(
      probeMapSource(url, origin, async () => result),
      pattern,
    )
  }
})
