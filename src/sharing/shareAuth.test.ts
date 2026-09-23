import assert from 'node:assert/strict'
import test from 'node:test'

import { createRedemptionProof, verifyRedemptionProof } from './shareAuth.ts'

test('binds a capability proof to the source, viewer, share and nonce', async () => {
  const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
  const input = {
    shareId: 'synthetic-share',
    sourcePeerId: 'synthetic-source',
    viewerPeerId: 'synthetic-viewer',
    viewerNonce: 'synthetic-nonce',
  }
  const proof = await createRedemptionProof(secret, input)

  assert.equal(await verifyRedemptionProof(secret, input, proof), true)
  assert.equal(
    await verifyRedemptionProof(secret, { ...input, viewerPeerId: 'different-viewer' }, proof),
    false,
  )
})
