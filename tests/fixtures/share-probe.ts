import { createPortClient } from '@taskyon/protocol'
import { PUBSUB_PEER_DISCOVERY } from '@taskyon/p2p-core/constants'
import { multiaddr } from '@multiformats/multiaddr'
import { createBrowserLocationSource } from '../../src/location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../../src/sharing/sharingRuntime.ts'

import {
  createConstellationMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
} from '../../src/sharing/browserPeer.ts'
import { base64UrlToBytes } from '../../src/sharing/encoding.ts'
import { createRedemptionProof } from '../../src/sharing/shareAuth.ts'
import { parseShareInvitation, shareInvitationUrl } from '../../src/sharing/shareLink.ts'
import { constellationProtocolV2, SHARE_STREAM_PROTOCOL } from '../../src/sharing/shareProtocol.ts'
import { classifyTransport } from '../../src/sharing/transport.ts'

export const probeWebRtcReachability = async (url: string, offerDelayMs = 0) => {
  const capability = parseShareInvitation(url)
  const address = capability.addresses.find((value) => value.includes('/webrtc'))
  if (!address) throw new Error('The share must advertise WebRTC reachability.')
  const { node } = await startPrivateBrowserPeer()
  // Preserve the method for restoration; calls below explicitly keep its connection receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const createOffer = RTCPeerConnection.prototype.createOffer
  const modernCreateOffer: (
    this: RTCPeerConnection,
    options?: RTCOfferOptions,
  ) => Promise<RTCSessionDescriptionInit> = createOffer
  function delayedOffer(
    this: RTCPeerConnection,
    options?: RTCOfferOptions,
  ): Promise<RTCSessionDescriptionInit>
  function delayedOffer(
    this: RTCPeerConnection,
    success: RTCSessionDescriptionCallback,
    failure: RTCPeerConnectionErrorCallback,
    options?: RTCOfferOptions,
  ): Promise<void>
  async function delayedOffer(
    this: RTCPeerConnection,
    optionsOrSuccess?: RTCOfferOptions | RTCSessionDescriptionCallback,
    failure?: RTCPeerConnectionErrorCallback,
    options?: RTCOfferOptions,
  ): Promise<RTCSessionDescriptionInit | void> {
    await new Promise((resolve) => setTimeout(resolve, offerDelayMs))
    if (typeof optionsOrSuccess === 'function') {
      if (!failure) throw new TypeError('The legacy offer requires a failure callback.')
      return createOffer.call(this, optionsOrSuccess, failure, options)
    }
    return modernCreateOffer.call(this, optionsOrSuccess)
  }
  if (offerDelayMs > 0) RTCPeerConnection.prototype.createOffer = delayedOffer
  try {
    const connection = await node.dial(multiaddr(address))
    return {
      direct: connection.direct,
      transport: classifyTransport(connection.remoteAddr.toString()),
      expectedPeer: connection.remotePeer.toString() === capability.sourcePeerId,
    }
  } finally {
    RTCPeerConnection.prototype.createOffer = createOffer
    await node.stop()
  }
}

export const probePrivateDiscovery = async () => {
  const { node } = await startPrivateBrowserPeer()
  let published = 0
  node.services.pubsub.publish = async (topic) => {
    if (topic === PUBSUB_PEER_DISCOVERY) published += 1
    return { recipients: [] }
  }
  try {
    node.dispatchEvent(
      new CustomEvent('self:peer:update', {
        detail: { peer: { id: node.peerId, addresses: [] } },
      }),
    )
    return published
  } finally {
    await node.stop()
  }
}

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

export const webRtcShareInvitation = (url: string): string => {
  const capability = parseShareInvitation(url)
  const addresses = capability.addresses.filter((address) => address.includes('/webrtc'))
  if (!addresses.length) throw new Error('The share must advertise WebRTC reachability.')
  return shareInvitationUrl({ ...capability, addresses }, url)
}
