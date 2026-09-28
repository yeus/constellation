import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionLog, describeDiagnosticError } from './sessionLog.ts'

test('keeps the newest 2000 entries and copies them oldest first', () => {
  let time = 0
  const log = createSessionLog(() => ++time)
  for (let index = 0; index < 2_001; index += 1) {
    log.record({
      level: 'info',
      event: index % 2 === 0 ? 'map.style.loaded' : 'map.archive.verified',
    })
  }

  assert.equal(log.snapshot().length, 2_000)
  assert.equal(log.snapshot()[0]?.timestampMs, 2)
  assert.equal(log.snapshot().at(-1)?.timestampMs, 2_001)
  assert.ok(
    log.format('browser').indexOf('map.archive.verified') <
      log.format('browser').lastIndexOf('map.style.loaded'),
  )
})

test('coalesces repeated errors and mirrors only redacted entries', () => {
  const mirrored: unknown[] = []
  const log = createSessionLog(
    () => 1_000,
    (entry) => mirrored.push(entry),
  )
  const input = {
    level: 'error' as const,
    event: 'map.error' as const,
    message:
      'Failed to fetch pmtiles://https://tiles.example.invalid/world.pmtiles?token=synthetic-secret',
  }
  log.record(input)
  log.record(input)

  assert.equal(log.snapshot().length, 1)
  assert.equal(log.snapshot()[0]?.repeatCount, 2)
  assert.equal(mirrored.length, 1)
  assert.doesNotMatch(JSON.stringify(mirrored), /synthetic-secret|tiles\.example/)
  assert.doesNotMatch(log.format('browser'), /synthetic-secret|tiles\.example/)
})

test('shows the actual error text with location and capability data removed', () => {
  const result = describeDiagnosticError(
    new Error(
      'AJAXError: Failed to fetch (0): pmtiles://https://tiles.example.invalid/world.pmtiles?token=synthetic-secret#share=synthetic-secret at 52.5200,13.4050',
    ),
  )

  assert.equal(result.category, 'network')
  assert.match(result.message, /AJAXError: Failed to fetch/)
  assert.doesNotMatch(result.message, /synthetic-secret|tiles\.example|52\.5200|13\.4050/)
})

test('removes standalone share secrets, local addresses, paths, and line breaks', () => {
  const result = describeDiagnosticError(
    new Error(
      'Tile failed\n#share=synthetic-secret peer 192.168.1.7 at /home/example/private/map.pmtiles',
    ),
  )

  assert.equal(result.category, 'tile')
  assert.doesNotMatch(result.message, /synthetic-secret|192\.168|\/home\/example|\n/)
})

test('records follow connection changes without a peer identifier', () => {
  const log = createSessionLog(() => 1_000)
  log.record({ level: 'warning', event: 'sharing.follow.status', state: 'disconnected' })
  log.record({ level: 'info', event: 'sharing.follow.status', state: 'connected' })

  assert.match(log.format('browser'), /sharing\.follow\.status · disconnected/)
  assert.match(log.format('browser'), /sharing\.follow\.status · connected/)
})

test('records transport-count changes without raw network addresses', () => {
  const log = createSessionLog(() => 1_000)
  log.record({
    level: 'info',
    event: 'sharing.network.connections',
    message: '2 connections: WebRTC, relay circuit',
  })

  assert.match(log.format('android'), /2 connections: WebRTC, relay circuit/)
  assert.doesNotMatch(log.format('android'), /\/ip4\//)
})

test('exports bounded session lifecycle reasons without a peer identity', () => {
  const log = createSessionLog(() => 1_000)
  log.record({
    level: 'warning',
    event: 'sharing.session.lifecycle',
    message: 'heartbeat-timeout; 1 active sessions',
  })

  assert.match(log.format('android'), /heartbeat-timeout; 1 active sessions/)
  assert.doesNotMatch(log.format('android'), /peer|\/ip4\/|#share=/i)
})
