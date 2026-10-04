import assert from 'node:assert/strict'
import test from 'node:test'

import { createShareInvitation } from '../sharing/shareLink.ts'
import { invitationFromSharedText } from './sharedText.ts'

test('extracts an invitation from a message without retaining surrounding text', async () => {
  const { url } = await createShareInvitation({
    baseUrl: 'https://constellation.taskyon.space/',
    sourcePeerId: 'peer-a',
    addresses: ['/ip4/127.0.0.1/tcp/9111/ws/p2p/peer-a'],
    expiresAt: Date.now() + 60_000,
  })
  assert.equal(invitationFromSharedText(`See me here: ${url}\nThanks!`), url)
  assert.equal(invitationFromSharedText(`https://example.test/#share=bad ${url}`), url)
  assert.equal(invitationFromSharedText('No location link here.'), undefined)
})
