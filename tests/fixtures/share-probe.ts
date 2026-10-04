import { createPortClient } from '@taskyon/protocol'
import { createBrowserLocationSource } from '../../src/location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../../src/sharing/sharingRuntime.ts'

import {
  createConstellationMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
} from '../../src/sharing/browserPeer.ts'
import { base64UrlToBytes } from '../../src/sharing/encoding.ts'
import { createRedemptionProof } from '../../src/sharing/shareAuth.ts'
import { parseShareInvitation } from '../../src/sharing/shareLink.ts'
import { constellationProtocolV2, SHARE_STREAM_PROTOCOL } from '../../src/sharing/shareProtocol.ts'

export const probeEndedShare = async (url: string) => {
  const capability = parseShareInvitation(url, 0)
  const { node } = await startPrivateBrowserPeer()
  const stream = await dialShareStream(node, capability.addresses, SHARE_STREAM_PROTOCOL, [])
  const messagePort = createConstellationMessagePort(stream)
  const client = createPortClient(messagePort.port, constellationProtocolV2)
  const viewerNonce = crypto.randomUUID()
  const redemption = { shareId: capability.shareId, viewerNonce }
  try {
    const invalidProofDenied = await client.share
      .redeem({ ...redemption, proof: 'a'.repeat(43) })
      .then(
        () => false,
        () => true,
      )
    const result = await client.share.redeem({
      ...redemption,
      proof: await createRedemptionProof(base64UrlToBytes(capability.secret), {
        ...redemption,
        sourcePeerId: capability.sourcePeerId,
        viewerPeerId: node.peerId.toString(),
      }),
    })
    const locationDenied = await client.sensor.describe({ sensorId: 'location' }).then(
      () => false,
      () => true,
    )
    const returnDenied = await client.share
      .offerReturn({
        sessionId: 'synthetic-ended-session',
        url,
        ownerPeerId: node.peerId.toString(),
      })
      .then(
        () => false,
        () => true,
      )
    return { invalidProofDenied, result, locationDenied, returnDenied }
  } finally {
    await messagePort.close()
    await node.stop()
  }
}

export const rejectEndedShare = async (url: string) => {
  const runtime = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-probe', geolocation: undefined }),
  )
  let state!: SharingRuntimeState
  runtime.subscribe((value) => {
    state = value
  })
  try {
    const rejected = await runtime.acceptShare(url, { saved: false }).then(
      () => false,
      () => true,
    )
    return {
      rejected,
      received: state.received.length,
      history: state.oldSeeing.map(({ reason }) => reason),
    }
  } finally {
    await runtime.stop()
  }
}
