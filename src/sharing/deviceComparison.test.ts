import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createComparisonCommit,
  createComparisonResponder,
  finishComparison,
  comparisonProof,
  comparisonLetters,
  reserveComparisonAttempt,
} from './deviceComparison.ts'

const binding = {
  shareId: 'synthetic-share-0001',
  sourcePeerId: 'source-A',
  viewerPeerId: 'viewer-B',
}
const secret = new Uint8Array(32).fill(7)
const setup = () => {
  let now = 1000
  let attempts = 0
  const results: string[] = []
  const responder = createComparisonResponder({
    authorize: async (shareId) => {
      assert.equal(shareId, binding.shareId)
      return { binding, secret }
    },
    reserve: async () => {
      if (++attempts > 3) throw new Error('Attempts exhausted')
    },
    now: () => now,
    complete: (result) => {
      results.push(result.letters)
    },
  })
  return {
    responder,
    results,
    advance: () => {
      now += 120001
    },
  }
}

test('commit/challenge/reveal agrees and produces four uppercase letters', async () => {
  const { responder, results } = setup()
  const commit = await createComparisonCommit(secret, binding)
  const challenge = await responder.commit(commit.request)
  const result = await finishComparison(secret, binding, commit, challenge, responder.reveal)
  assert.match(result.letters, /^[A-Z]{4}$/)
  assert.deepEqual(results, [result.letters])
})

test('authenticated identities, share and challenge are bound to every proof', async () => {
  const { responder } = setup()
  const altered = await createComparisonCommit(secret, { ...binding, viewerPeerId: 'viewer-C' })
  await assert.rejects(responder.commit(altered.request), /denied/i)
  const commit = await createComparisonCommit(secret, binding)
  const challenge = await setup().responder.commit(commit.request)
  await assert.rejects(
    finishComparison(
      secret,
      { ...binding, sourcePeerId: 'source-C' },
      commit,
      challenge,
      responder.reveal,
    ),
    /denied/i,
  )
  assert.notEqual(
    await comparisonProof(secret, 'test', [binding.shareId]),
    await comparisonProof(secret, 'test', ['other-share']),
  )
  const transcript = [
    binding.shareId,
    binding.sourcePeerId,
    binding.viewerPeerId,
    commit.nonce,
    challenge.challenge,
  ]
  assert.notEqual(
    await comparisonLetters(secret, transcript),
    await comparisonLetters(secret, [...transcript, 'altered']),
  )
})

test('reveal replay, expired challenges and cancellation cannot complete', async () => {
  for (const action of ['replay', 'expiry', 'cancel']) {
    const { responder, advance, results } = setup()
    const commit = await createComparisonCommit(secret, binding)
    const challenge = await responder.commit(commit.request)
    let reveal!: Parameters<typeof responder.reveal>[0]
    if (action === 'expiry') advance()
    if (action === 'cancel') responder.cancel()
    const finish = () =>
      finishComparison(secret, binding, commit, challenge, async (request) => {
        reveal = request
        return responder.reveal(request)
      })
    if (action === 'replay') {
      await finish()
      await assert.rejects(responder.reveal(reveal), /denied/i)
      assert.equal(results.length, 1)
    } else {
      await assert.rejects(finish(), /denied/i)
      assert.equal(results.length, 0)
    }
  }
})

test('attempt reservation is bounded, durable before challenge and fail closed', async () => {
  const budgets: { shareId: string; ownPeerId: string; attempts: number }[] = []
  let saves = 0
  for (let index = 0; index < 3; index++)
    await reserveComparisonAttempt(budgets, binding.shareId, binding.sourcePeerId, async () => {
      saves++
    })
  await assert.rejects(
    reserveComparisonAttempt(budgets, binding.shareId, binding.sourcePeerId, async () => {
      saves++
    }),
    /attempt/i,
  )
  assert.equal(saves, 3)
  const restored = structuredClone(budgets)
  await assert.rejects(
    reserveComparisonAttempt(
      restored,
      binding.shareId,
      binding.sourcePeerId,
      async () => undefined,
    ),
    /attempt/i,
  )
  const failed: typeof budgets = []
  await assert.rejects(
    reserveComparisonAttempt(failed, binding.shareId, binding.sourcePeerId, async () => {
      throw new Error('storage')
    }),
    /storage/,
  )
  assert.equal(failed[0]?.attempts, 1)
})

test('versioned application RPC integrates without changing strict location messages', async () => {
  const { createDuplexChannel, createPortClient, createPortServer } = await import(
    '@taskyon/protocol'
  )
  const { deviceComparisonProtocol, DEVICE_COMPARISON_PROTOCOL } = await import(
    './deviceComparison.ts'
  )
  const { SHARE_STREAM_PROTOCOL, constellationProtocolV2 } = await import('./shareProtocol.ts')
  const channel = createDuplexChannel<
    ReturnType<typeof deviceComparisonProtocol.message.parse>,
    ReturnType<typeof deviceComparisonProtocol.message.parse>
  >()
  const { responder, results } = setup()
  const stop = createPortServer(channel.y, deviceComparisonProtocol, {
    comparison: { commit: responder.commit, reveal: responder.reveal },
  })
  try {
    const client = createPortClient(channel.x, deviceComparisonProtocol)
    const commit = await createComparisonCommit(secret, binding)
    const response = await client.comparison.commit(commit.request)
    const result = await finishComparison(secret, binding, commit, response, (request) =>
      client.comparison.reveal(request),
    )
    assert.deepEqual(results, [result.letters])
    assert.notEqual(DEVICE_COMPARISON_PROTOCOL, SHARE_STREAM_PROTOCOL)
    assert.equal(
      constellationProtocolV2.message.safeParse({
        type: 'comparison.commit',
        requestId: 'synthetic',
        ...commit.request,
      }).success,
      false,
    )
  } finally {
    stop()
  }
})

test('changed reveal and an old reveal on a fresh challenge fail closed', async () => {
  const first = setup()
  const commit = await createComparisonCommit(secret, binding)
  const challenge = await first.responder.commit(commit.request)
  let saved!: Parameters<typeof first.responder.reveal>[0]
  await finishComparison(secret, binding, commit, challenge, async (request) => {
    saved = request
    return first.responder.reveal(request)
  })
  const second = setup()
  await second.responder.commit(commit.request)
  await assert.rejects(second.responder.reveal(saved), /denied/i)
  const third = setup()
  const thirdChallenge = await third.responder.commit(commit.request)
  await assert.rejects(
    finishComparison(secret, binding, commit, thirdChallenge, (request) =>
      third.responder.reveal({ ...request, nonce: 'A'.repeat(43) }),
    ),
    /denied/i,
  )
  assert.deepEqual(second.results, [])
  assert.deepEqual(third.results, [])
})

test('comparison uses the authenticated owner of the exact stream, not invitation text or a stream ID', async () => {
  const { requireComparisonStreamPeer } = await import('./deviceComparison.ts')
  const stream = { id: 'same-id' },
    unrelatedStream = { id: 'same-id' }
  const connection = (remote: string, streams: (typeof stream)[]) => ({
    remotePeer: { toString: () => remote },
    status: 'open',
    streams,
  })
  requireComparisonStreamPeer(stream, [connection('source-A', [stream])], 'source-A')
  assert.throws(
    () => requireComparisonStreamPeer(stream, [connection('source-C', [stream])], 'source-A'),
    /authenticated peer/i,
  )
  assert.throws(
    () =>
      requireComparisonStreamPeer(stream, [connection('source-A', [unrelatedStream])], 'source-A'),
    /authenticated peer/i,
  )
  assert.throws(
    () =>
      requireComparisonStreamPeer(
        stream,
        [{ ...connection('source-A', [stream]), status: 'closed' }],
        'source-A',
      ),
    /authenticated peer/i,
  )
})
