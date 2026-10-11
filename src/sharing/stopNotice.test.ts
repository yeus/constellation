import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recordStoppedViewer,
  rotatePendingNotice,
  shouldQueueStopNotice,
  preparePendingStopNotice,
  dispatchStopDelivery,
} from './stopNotice.ts'
import { createStopNoticeProof, verifyStopNoticeProof } from './shareAuth.ts'
import { createShareInvitation } from './shareLink.ts'
import { base64UrlToBytes } from './encoding.ts'
import type { StoppedViewerRecord } from './privateStore.ts'

const record = {
  shareId: 'synthetic-share-id',
  peerId: 'synthetic-peer',
  eventId: 'synthetic-event-id',
}

test('durable stop queue contains a scoped proof rather than a location bearer capability', async () => {
  const invitation = await createShareInvitation({
    baseUrl: 'https://example.test/',
    sourcePeerId: 'synthetic-source',
    addresses: ['/dns4/synthetic.invalid/tcp/443/wss'],
    expiresAt: null,
  })
  const pending = await preparePendingStopNotice(
    invitation.url,
    'synthetic-stop-event-id',
    'synthetic-viewer',
    12_345,
  )
  assert.equal(pending.shareId, invitation.capability.shareId)
  assert.equal(pending.sourcePeerId, invitation.capability.sourcePeerId)
  assert.equal(pending.viewerPeerId, 'synthetic-viewer')
  assert.equal(pending.queuedAt, 12_345)
  assert.deepEqual(pending.addresses, invitation.capability.addresses)
  assert.equal(JSON.stringify(pending).includes(invitation.capability.secret), false)
  assert.equal(JSON.stringify(pending).includes('#share='), false)
  assert.equal(JSON.stringify(pending).includes(invitation.url), false)
  assert.equal(
    await verifyStopNoticeProof(
      base64UrlToBytes(invitation.capability.secret),
      {
        shareId: pending.shareId,
        sourcePeerId: pending.sourcePeerId,
        viewerPeerId: pending.viewerPeerId,
        eventId: pending.eventId,
      },
      pending.proof,
    ),
    true,
  )
})

test('offline stop notice proof binds both authenticated peers, exact share and event', async () => {
  const secret = new Uint8Array(32).fill(5)
  const binding = { ...record, sourcePeerId: 'synthetic-owner', viewerPeerId: record.peerId }
  const proof = await createStopNoticeProof(secret, binding)
  assert.equal(await verifyStopNoticeProof(secret, binding, proof), true)
  for (const wrong of [
    { ...binding, sourcePeerId: 'different-owner' },
    { ...binding, viewerPeerId: 'different-peer' },
    { ...binding, shareId: 'different-share' },
    { ...binding, eventId: 'different-event' },
  ])
    assert.equal(await verifyStopNoticeProof(secret, wrong, proof), false)
  assert.equal(await verifyStopNoticeProof(new Uint8Array(32), binding, proof), false)
  assert.equal(await verifyStopNoticeProof(secret, binding, 'bad-proof'), false)
})

test('stop notices persist before acknowledgement, deduplicate retry and rollback failures', async () => {
  const history = new Map<string, StoppedViewerRecord>()
  let writes = 0
  const persist = async () => {
    writes++
  }
  assert.equal(await recordStoppedViewer(history, record, persist, 12345), 12345)
  assert.equal(await recordStoppedViewer(history, record, persist, 30000), 12345)
  assert.equal(writes, 1)
  const changed = { ...record, eventId: 'another-event-id-1234' }
  await assert.rejects(
    recordStoppedViewer(
      history,
      changed,
      async () => {
        throw new Error('storage failure')
      },
      30000,
    ),
    /storage failure/,
  )
  assert.equal([...history.values()][0]?.eventId, record.eventId)
})

test('late replay of an older acknowledged event cannot replace a newer stop', async () => {
  const history = new Map<string, StoppedViewerRecord>()
  let writes = 0
  const persist = async () => {
    writes++
  }
  await recordStoppedViewer(history, record, persist, 1_000)
  const newer = { ...record, eventId: 'synthetic-newer-event-id' }
  await recordStoppedViewer(history, newer, persist, 2_000)
  const previousWrites = writes
  assert.equal(await recordStoppedViewer(history, record, persist, 3_000), 1_000)
  assert.equal(writes, previousWrites)
  const current = [...history.values()][0]!
  assert.equal(current.eventId, newer.eventId)
  assert.equal(current.recordedAt, 2_000)
  assert.deepEqual(current.recentEvents, [{ eventId: record.eventId, recordedAt: 1_000 }])
})

test('recent stop-event replay ledger remains bounded during repeated re-following', async () => {
  const history = new Map<string, StoppedViewerRecord>()
  for (let index = 0; index < 20; index++) {
    await recordStoppedViewer(
      history,
      {
        ...record,
        eventId: `synthetic-event-${String(index).padStart(16, '0')}`,
      },
      async () => {},
      index + 100,
    )
  }
  const current = [...history.values()][0]!
  assert.equal(current.recentEvents?.length, 16)
  assert.equal(current.recordedAt, 119)
  assert.equal(current.recentEvents?.[0]?.recordedAt, 103)
  assert.equal(current.recentEvents?.[15]?.recordedAt, 118)
})

test('stop-notice history remains schema bounded even at maximum capacity', async () => {
  const history = new Map<string, StoppedViewerRecord>()
  for (let index = 0; index < 129; index++) {
    await recordStoppedViewer(
      history,
      {
        ...record,
        peerId: `synthetic-peer-${index}`,
      },
      async () => {
        assert.ok(history.size <= 128)
      },
      index + 1,
    )
  }
  assert.equal(history.size, 128)
  assert.equal([...history.values()][0]?.peerId, 'synthetic-peer-1')
})

test('failed retry advances bounded queue instead of starving later notices', () => {
  const queue = new Map([
    ['offline-a', 'a'],
    ['offline-b', 'b'],
    ['online-c', 'c'],
  ])
  rotatePendingNotice(queue, 'offline-a')
  rotatePendingNotice(queue, 'offline-b')
  assert.deepEqual([...queue.keys()], ['online-c', 'offline-a', 'offline-b'])
  rotatePendingNotice(queue, 'missing')
  assert.equal(queue.size, 3)
})

test('stopping an unsaved preview still queues a protected stop notice', () => {
  // Queue policy depends on secure storage, not whether the follow was saved.
  assert.equal(shouldQueueStopNotice(true, true), true)
  assert.equal(shouldQueueStopNotice(false, true), false)
  assert.equal(shouldQueueStopNotice(true, false), false)
})

test('stopping returns without waiting for an offline network response', async () => {
  let resolve!: (value: boolean) => void
  const remote = new Promise<boolean>((done) => {
    resolve = done
  })
  const observed: boolean[] = []
  const result = dispatchStopDelivery(
    () => remote,
    async (confirmed) => {
      observed.push(confirmed)
    },
  )
  assert.equal(result, undefined)
  assert.equal(observed.length, 0)
  resolve(true)
  await new Promise((done) => setImmediate(done))
  assert.equal(observed[0], true)
  dispatchStopDelivery(
    async () => {
      throw new Error('offline')
    },
    async (confirmed) => {
      observed.push(confirmed)
    },
  )
  await new Promise((done) => setImmediate(done))
  assert.equal(observed[1], false)
})
