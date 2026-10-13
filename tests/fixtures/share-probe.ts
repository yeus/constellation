import { createPortClient } from '@taskyon/protocol'
import { PUBSUB_PEER_DISCOVERY } from '@taskyon/p2p-core/constants'
import { multiaddr } from '@multiformats/multiaddr'
import { createBrowserLocationSource } from '../../src/location/browser.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../../src/sharing/sharingRuntime.ts'

import {
  createProtocolMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
} from '../../src/sharing/browserPeer.ts'
import { base64UrlToBytes } from '../../src/sharing/encoding.ts'
import { createRedemptionProof } from '../../src/sharing/shareAuth.ts'
import { parseShareInvitation, shareInvitationUrl } from '../../src/sharing/shareLink.ts'
import {
  constellationProtocolV2,
  parseConstellationMessage,
  SHARE_STREAM_PROTOCOL,
} from '../../src/sharing/shareProtocol.ts'
import { classifyTransport } from '../../src/sharing/transport.ts'
import { createShareDraft } from '../../src/shareDraft.ts'
import type { PrivateState } from '../../src/sharing/privateStore.ts'

export const probePeerNames = async () => {
  const source = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-source', geolocation: undefined }),
    undefined,
    { load: async () => undefined, save: async () => undefined },
  )
  const viewer = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
    undefined,
    { load: async () => undefined, save: async () => undefined },
  )
  let sourceState!: SharingRuntimeState, viewerState!: SharingRuntimeState
  source.subscribe((state) => {
    sourceState = state
  })
  viewer.subscribe((state) => {
    viewerState = state
  })
  const wait = async (matches: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!matches()) {
      if (Date.now() > deadline) throw new Error('Synthetic name synchronization timed out.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    const share = await source.createShare({
      ...createShareDraft(),
      viewerCapacity: 10,
      name: 'Link label',
    })
    await viewer.acceptShare(share.url)
    const sourceId = viewerState.following[0]!.peerId!
    const viewerId = sourceState.shares[0]!.viewers![0]!.peerId
    const defaultNames = Boolean(sourceState.shares[0]!.viewers![0]!.sourceName)
    const linkNamePreserved = viewerState.following[0]!.sourceName === 'Link label'
    await source.setPeerNamePreferences(viewerId, false, 'Alice')
    await wait(() => viewerState.following[0]!.sourceName === 'Alice')
    const initialDisplayName = viewerState.following[0]!.displayName
    await viewer.adoptPeerName(sourceId, 'Alice')
    const adoptedDisplayName = viewerState.following[0]!.displayName
    const oneDirection = viewerState.following[0]!.sourceName
    const reverseInitiallyPrivate = !sourceState.shares[0]!.viewers![0]!.sourceName
    await viewer.setPeerNamePreferences(sourceId, true, 'Bob')
    await wait(() => sourceState.shares[0]!.viewers![0]!.sourceName === 'Bob')
    const reverseOptIn = sourceState.shares[0]!.viewers![0]!.sourceName
    await viewer.setPeerNamePreferences(sourceId, true, 'Bobby')
    await wait(() => sourceState.shares[0]!.viewers![0]!.sourceName === 'Bobby')
    const viewerUpdatePending = sourceState.shares[0]!.viewers![0]!.displayName === 'Bob'
    await source.adoptPeerName(viewerId, 'Bobby')
    const viewerUpdateAdopted = sourceState.shares[0]!.viewers![0]!.displayName === 'Bobby'
    viewer.setFollowName(share.shareId, 'Mum')
    await source.setPeerNamePreferences(viewerId, false, 'Alicia')
    await wait(() => viewerState.following[0]!.sourceName === 'Alicia')
    const privateNickname = viewerState.following[0]!.localName
    const sharedUpdate = viewerState.following[0]!.sourceName
    await source.setPeerNamePreferences(viewerId, false, null)
    await wait(() => viewerState.following[0]!.sourceName === 'Link label')
    await viewer.adoptPeerName(sourceId, 'Link label')
    const linkNameAdoptedAfterClear = viewerState.following[0]!.displayName === 'Link label'
    return {
      defaultNames,
      initialDisplayName,
      adoptedDisplayName,
      linkNamePreserved,
      linkNameAdoptedAfterClear,
      oneDirection,
      reverseInitiallyPrivate,
      reverseOptIn,
      viewerUpdatePending,
      viewerUpdateAdopted,
      privateNickname,
      sharedUpdate,
      linkNameRestoredAfterClear: viewerState.following[0]!.sourceName === 'Link label',
    }
  } finally {
    await viewer.stop()
    await source.stop()
  }
}

export const probeRevocationDuringAdmission = async () => {
  const source = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-source', geolocation: undefined }),
    undefined,
    { load: async () => undefined, save: async () => undefined },
  )
  const viewer = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
  )
  let revocation: Promise<void> | undefined
  let viewerState!: SharingRuntimeState
  source.subscribe((state) => {
    const admitted = state.shares.find((share) => share.viewerCount > 0)
    if (admitted && !revocation) revocation = source.stopShare(admitted.shareId)
  })
  viewer.subscribe((state) => {
    viewerState = state
  })
  try {
    const share = await source.createShare({ ...createShareDraft(), viewerCapacity: 10 })
    await viewer.acceptShare(share.url, { saved: false }).catch(() => undefined)
    await revocation
    return {
      following: viewerState.following.map(({ status }) => status),
      history: viewerState.oldSeeing.map(({ reason }) => reason),
    }
  } finally {
    await viewer.stop()
    await source.stop()
  }
}

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
  const messagePort = createProtocolMessagePort(stream, parseConstellationMessage)
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

export const probeInitialNamesAndReturnPresence = async () => {
  const source = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-source', geolocation: undefined }),
    undefined,
    { load: async () => undefined, save: async () => undefined },
  )
  const viewer = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
    undefined,
    { load: async () => undefined, save: async () => undefined },
  )
  let sourceState!: SharingRuntimeState, viewerState!: SharingRuntimeState
  source.subscribe((state) => {
    sourceState = state
  })
  viewer.subscribe((state) => {
    viewerState = state
  })
  const wait = async (matches: () => boolean) => {
    const deadline = Date.now() + 15_000
    while (!matches()) {
      if (Date.now() > deadline) throw new Error('Synthetic contact lifecycle timed out.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    const share = await source.createShare({ ...createShareDraft('River'), viewerCapacity: 1 })
    await viewer.acceptShare(share.url)
    const pendingName = viewerState.following[0]!.displayName
    const request = sourceState.pendingViewerApprovals[0]!
    await source.approveViewer(request.shareId, request.peerId)
    await viewer.acceptShare(share.url)
    const initialName = viewerState.following[0]!.displayName
    const returned = await viewer.createShare(createShareDraft('Forest'))
    await viewer.offerReturnShare(share.shareId, returned.url)
    const recipientBound =
      viewerState.shares[0]!.recipientPeerId === viewerState.following[0]!.peerId
    await wait(() => sourceState.returnOffers.length === 1)
    await source.approveReturnLink(share.shareId)
    await wait(
      () =>
        viewerState.shares[0]!.viewerCount === 1 && sourceState.following[0]?.connected === true,
    )
    const returnViewerCount = viewerState.shares[0]!.viewerCount
    const reciprocalPeer =
      viewerState.shares[0]!.viewers![0]!.peerId === viewerState.following[0]!.peerId
    return {
      pendingAliasReplaced: pendingName !== initialName,
      initialName,
      recipientBound,
      returnViewerCount,
      reciprocalPeer,
    }
  } finally {
    await viewer.stop()
    await source.stop()
  }
}

export const probeLateInitialName = async () => {
  const source = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-source', geolocation: undefined }),
    undefined,
    { load: async () => undefined, save: async () => undefined },
  )
  let snapshot: PrivateState | undefined
  const store = {
    load: async () => snapshot,
    save: async (value: NonNullable<typeof snapshot>) => {
      snapshot = value
    },
  }
  const viewer = createSharingRuntime(
    createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
    undefined,
    store,
  )
  let restored: ReturnType<typeof createSharingRuntime> | undefined
  let sourceState!: SharingRuntimeState, viewerState!: SharingRuntimeState
  source.subscribe((state) => {
    sourceState = state
  })
  viewer.subscribe((state) => {
    viewerState = state
  })
  const wait = async (matches: () => boolean) => {
    const deadline = Date.now() + 15_000
    while (!matches()) {
      if (Date.now() > deadline) throw new Error('Synthetic late-name flow timed out.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    const share = await source.createShare({ ...createShareDraft(), viewerCapacity: 10 })
    await viewer.acceptShare(share.url, { saved: false })
    await viewer.saveFollowing(share.shareId, viewerState.following[0]!.localName)
    const provisionalStaysProvisional = snapshot!.followed[0]!.usesPrivateName === false
    const viewerId = sourceState.shares[0]!.viewers![0]!.peerId
    await source.setPeerNamePreferences(viewerId, false, 'Late name')
    await wait(() => viewerState.following[0]!.displayName === 'Late name')
    const initialName = viewerState.following[0]!.displayName
    await source.setPeerNamePreferences(viewerId, false, 'Updated name')
    await wait(() => viewerState.following[0]!.sourceName === 'Updated name')
    const updateStaysPending = viewerState.following[0]!.displayName === 'Late name'
    await viewer.stop()
    restored = createSharingRuntime(
      createBrowserLocationSource({ sourceId: 'synthetic-viewer', geolocation: undefined }),
      undefined,
      store,
    )
    let restoredState!: SharingRuntimeState
    restored.subscribe((state) => {
      restoredState = state
    })
    await restored.initialize()
    await wait(() => restoredState.following[0]?.connected === true)
    return {
      provisionalStaysProvisional,
      initialName,
      updateStaysPending,
      restoredName: restoredState.following[0]!.displayName,
    }
  } finally {
    await restored?.stop()
    await viewer.stop()
    await source.stop()
  }
}
