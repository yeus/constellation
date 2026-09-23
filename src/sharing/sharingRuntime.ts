import { createPortClient, createPortServer } from '@taskyon/protocol'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'

import { projectApproximateLocation, type ApproximationState } from '../location/approximation.ts'
import type { BrowserLocationSource, BrowserLocationState } from '../location/browser.ts'
import {
  acceptNewerLocationObservation,
  parseLocationObservationV1,
  type LocationObservationV1,
} from '../location/locationObservation.ts'
import { shareExpiryFor, type ShareDraft } from '../shareDraft.ts'
import {
  createConstellationMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
  type ConstellationMessage,
} from './browserPeer.ts'
import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'
import { createRedemptionProof, verifyRedemptionProof } from './shareAuth.ts'
import { createShareInvitation, parseShareInvitation, type ShareCapability } from './shareLink.ts'
import { constellationProtocolV1, SHARE_STREAM_PROTOCOL } from './shareProtocol.ts'

const LOCATION_SENSOR_ID = 'location'
const DESCRIPTOR_REVISION = 'constellation-location-v1'
const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_TIMEOUT_MS = 35_000
const MAX_ACTIVE_SESSIONS = 128
const MAX_REDEEMED_NONCES_PER_SHARE = 1_024

type PeerStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface ShareSummary {
  readonly shareId: string
  readonly url: string
  readonly precision: ShareDraft['precision']
  readonly expiresAt: number | null
  readonly viewerCount: number
}

export interface SharingRuntimeState {
  readonly peerStatus: PeerStatus
  readonly location: BrowserLocationState
  readonly shares: readonly ShareSummary[]
  readonly received: readonly {
    observation: LocationObservationV1
    state: 'live' | 'delayed' | 'stale'
  }[]
  readonly message: string
}

interface SourceSession {
  readonly peerId: string
  readonly close: () => Promise<void>
  readonly send: (message: ConstellationMessage) => void
  sessionId?: string
  subscriptionId?: string
  lastHeartbeatAt: number
}

interface SourceShare {
  readonly capability: ShareCapability
  readonly url: string
  readonly secret: Uint8Array
  readonly precision: ShareDraft['precision']
  readonly capacity: number
  readonly sessions: Set<SourceSession>
  readonly redeemedNonces: Set<string>
  approximation?: ApproximationState
  latest?: LocationObservationV1
}

const randomToken = (bytes = 16): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))

const capacityFor = (draft: ShareDraft): number =>
  Math.min(
    draft.viewerCapacity === 'unlimited' ? MAX_ACTIVE_SESSIONS : draft.viewerCapacity,
    MAX_ACTIVE_SESSIONS,
  )

export const rememberRedeemedNonce = (
  nonces: Set<string>,
  nonce: string,
  maximum = MAX_REDEEMED_NONCES_PER_SHARE,
): void => {
  nonces.add(nonce)
  while (nonces.size > maximum) {
    const oldest = nonces.values().next().value
    if (oldest === undefined) return
    nonces.delete(oldest)
  }
}

const requireAuthorized = (session: SourceSession, share: SourceShare | undefined): SourceShare => {
  if (!share || !session.sessionId) throw new Error('Share access denied.')
  if (share.capability.expiresAt !== null && Date.now() >= share.capability.expiresAt) {
    throw new Error('Share access denied.')
  }
  return share
}

export const createSharingRuntime = (
  locationSource: BrowserLocationSource,
  shareBaseUrl = window.location.origin + window.location.pathname,
): {
  subscribe: (observer: (state: SharingRuntimeState) => void) => () => void
  createShare: (draft: ShareDraft, expiresAt?: number | null) => Promise<ShareSummary>
  acceptShare: (url: string, label?: string) => Promise<void>
  stopShare: (shareId: string) => Promise<void>
  stop: () => Promise<void>
} => {
  const observers = new Set<(state: SharingRuntimeState) => void>()
  const shares = new Map<string, SourceShare>()
  const received = new Map<string, LocationObservationV1>()
  const viewerClosers = new Set<() => Promise<void>>()
  let peer: Promise<{ node: BrowserLibp2pNode; addresses: string[] }> | undefined
  let handlerNode: BrowserLibp2pNode | undefined
  let state: SharingRuntimeState = {
    peerStatus: 'offline',
    location: locationSource.getState(),
    shares: [],
    received: [],
    message: '',
  }

  const publish = (patch: Partial<SharingRuntimeState> = {}): void => {
    const now = Date.now()
    state = {
      ...state,
      ...patch,
      shares: [...shares.values()].map((share) => ({
        shareId: share.capability.shareId,
        url: share.url,
        precision: share.precision,
        expiresAt: share.capability.expiresAt,
        viewerCount: share.sessions.size,
      })),
      received: [...received.values()].map((observation) => ({
        observation,
        state:
          now >= observation.expiresAt
            ? 'stale'
            : now >= observation.capturedAt + 15_000
              ? 'delayed'
              : 'live',
      })),
    }
    observers.forEach((observer) => observer(state))
  }

  const removeSession = (session: SourceSession): void => {
    for (const share of shares.values()) share.sessions.delete(session)
    publish()
  }

  const handleIncomingStream = (
    stream: Parameters<typeof createConstellationMessagePort>[0],
    connection: { remotePeer: { toString: () => string } },
  ): void => {
    const messagePort = createConstellationMessagePort(stream)
    const session: SourceSession = {
      peerId: connection.remotePeer.toString(),
      close: () => messagePort.close(),
      send: messagePort.port.send,
      lastHeartbeatAt: Date.now(),
    }
    let authorizedShare: SourceShare | undefined
    const stopServer = createPortServer(
      messagePort.port,
      constellationProtocolV1,
      {
        share: {
          redeem: async ({ shareId, viewerNonce, proof }) => {
            const candidate = shares.get(shareId)
            const permitted =
              candidate &&
              !candidate.redeemedNonces.has(viewerNonce) &&
              candidate.sessions.size < candidate.capacity &&
              (candidate.capability.expiresAt === null ||
                Date.now() < candidate.capability.expiresAt) &&
              (await verifyRedemptionProof(
                candidate.secret,
                {
                  shareId,
                  sourcePeerId: candidate.capability.sourcePeerId,
                  viewerPeerId: session.peerId,
                  viewerNonce,
                },
                proof,
              ))
            if (!candidate || !permitted) throw new Error('Share access denied.')
            authorizedShare = candidate
            session.sessionId = randomToken()
            session.lastHeartbeatAt = Date.now()
            rememberRedeemedNonce(candidate.redeemedNonces, viewerNonce)
            candidate.sessions.add(session)
            publish()
            return {
              sessionId: session.sessionId,
              expiresAt: candidate.capability.expiresAt,
              precision: candidate.precision,
              heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            }
          },
          heartbeat: ({ sessionId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId || !share.sessions.has(session)) {
              throw new Error('Share access denied.')
            }
            session.lastHeartbeatAt = Date.now()
            return { receivedAt: session.lastHeartbeatAt }
          },
          leave: ({ sessionId }) => {
            requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId) throw new Error('Share access denied.')
            removeSession(session)
          },
        },
        sensor: {
          describe: ({ sensorId }) => {
            requireAuthorized(session, authorizedShare)
            if (sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
            return {
              sensorId,
              profile: { id: 'dev.constellation.location', version: '1' },
              descriptorRevision: DESCRIPTOR_REVISION,
            }
          },
          subscribe: ({ sensorId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
            session.subscriptionId = randomToken()
            if (share.latest) {
              session.send(
                constellationProtocolV1.streams['sensor.observations'].observation.parse({
                  type: 'observation',
                  subscriptionId: session.subscriptionId,
                  observation: {
                    sensorId: LOCATION_SENSOR_ID,
                    descriptorRevision: DESCRIPTOR_REVISION,
                    sourcePrincipal: share.capability.sourcePeerId,
                    sequence: share.latest.sequence,
                    capturedAt: share.latest.capturedAt,
                    expiresAt: share.latest.expiresAt,
                    payload: share.latest,
                  },
                }),
              )
            }
            return { subscriptionId: session.subscriptionId }
          },
          unsubscribe: ({ subscriptionId }) => {
            requireAuthorized(session, authorizedShare)
            if (session.subscriptionId !== subscriptionId) {
              throw new Error('Sensor access denied.')
            }
            session.subscriptionId = undefined
          },
        },
      },
      { onError: () => undefined },
    )
    void messagePort.closed.then(() => {
      stopServer()
      removeSession(session)
    })
  }

  const ensurePeer = async () => {
    if (!peer) {
      publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
      peer = startPrivateBrowserPeer()
        .then(async (started) => {
          await started.node.handle(SHARE_STREAM_PROTOCOL, handleIncomingStream, {
            runOnLimitedConnection: true,
          })
          handlerNode = started.node
          publish({ peerStatus: 'online', message: '' })
          return started
        })
        .catch((error) => {
          peer = undefined
          publish({
            peerStatus: 'error',
            message: error instanceof Error ? error.message : 'P2P connection failed.',
          })
          throw error
        })
    }
    return peer
  }

  const unsubscribeLocationState = locationSource.subscribeState((location) =>
    publish({ location }),
  )
  const unsubscribeLocationObservation = locationSource.subscribeObservation((exact) => {
    for (const share of shares.values()) {
      if (share.precision === 'approximate') {
        const projected = projectApproximateLocation(exact, share.approximation)
        share.approximation = projected.state
        share.latest = projected.observation
      } else {
        share.latest = exact
      }
      for (const session of share.sessions) {
        if (!session.subscriptionId || !share.latest) continue
        session.send(
          constellationProtocolV1.streams['sensor.observations'].observation.parse({
            type: 'observation',
            subscriptionId: session.subscriptionId,
            observation: {
              sensorId: LOCATION_SENSOR_ID,
              descriptorRevision: DESCRIPTOR_REVISION,
              sourcePrincipal: share.capability.sourcePeerId,
              sequence: share.latest.sequence,
              capturedAt: share.latest.capturedAt,
              expiresAt: share.latest.expiresAt,
              payload: share.latest,
            },
          }),
        )
      }
    }
  })

  const heartbeatSweep = window.setInterval(() => {
    const now = Date.now()
    for (const share of shares.values()) {
      const expired = share.capability.expiresAt !== null && now >= share.capability.expiresAt
      for (const session of share.sessions) {
        if (expired || now - session.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          removeSession(session)
          void session.close()
        }
      }
      if (expired) shares.delete(share.capability.shareId)
    }
    if (shares.size === 0) locationSource.stop()
    publish()
  }, HEARTBEAT_INTERVAL_MS)

  return {
    subscribe: (observer) => {
      observers.add(observer)
      observer(state)
      return () => observers.delete(observer)
    },
    createShare: async (draft, expiresAt = shareExpiryFor(draft, Date.now())) => {
      const { node, addresses } = await ensurePeer()
      const invitation = createShareInvitation({
        baseUrl: shareBaseUrl,
        sourcePeerId: node.peerId.toString(),
        addresses,
        expiresAt,
      })
      const share: SourceShare = {
        capability: invitation.capability,
        url: invitation.url,
        secret: base64UrlToBytes(invitation.capability.secret),
        precision: draft.precision,
        capacity: capacityFor(draft),
        sessions: new Set(),
        redeemedNonces: new Set(),
      }
      shares.set(share.capability.shareId, share)
      locationSource.start()
      publish()
      return state.shares.find(({ shareId }) => shareId === share.capability.shareId)!
    },
    acceptShare: async (url, label) => {
      const capability = parseShareInvitation(url)
      const { node } = await ensurePeer()
      const stream = await dialShareStream(node, capability.addresses, SHARE_STREAM_PROTOCOL)
      const messagePort = createConstellationMessagePort(stream)
      const client = createPortClient(messagePort.port, constellationProtocolV1)
      const viewerNonce = randomToken()
      const session = await client.share.redeem({
        shareId: capability.shareId,
        viewerNonce,
        proof: await createRedemptionProof(base64UrlToBytes(capability.secret), {
          shareId: capability.shareId,
          sourcePeerId: capability.sourcePeerId,
          viewerPeerId: node.peerId.toString(),
          viewerNonce,
        }),
        ...(label?.trim() ? { label: label.trim() } : {}),
      })
      await client.sensor.describe({ sensorId: LOCATION_SENSOR_ID })
      const activeSubscription: { id?: string } = {}
      let pendingObservation: unknown
      const receiveObservation = (payload: unknown): void => {
        try {
          const observation = parseLocationObservationV1(payload)
          const current = received.get(capability.shareId)
          if (!acceptNewerLocationObservation(current, observation)) return
          received.set(capability.shareId, observation)
          publish({ message: '' })
        } catch {
          // Invalid location payloads are ignored without retaining their data.
        }
      }
      const unsubscribe = messagePort.port.receive((message) => {
        const parsed =
          constellationProtocolV1.streams['sensor.observations'].observation.safeParse(message)
        if (!parsed.success) return
        if (!activeSubscription.id) {
          pendingObservation = parsed.data
          return
        }
        if (parsed.data.subscriptionId === activeSubscription.id) {
          receiveObservation(parsed.data.observation.payload)
        }
      })
      const subscription = await client.sensor.subscribe({
        sensorId: LOCATION_SENSOR_ID,
      })
      activeSubscription.id = subscription.subscriptionId
      const pending =
        constellationProtocolV1.streams['sensor.observations'].observation.safeParse(
          pendingObservation,
        )
      if (pending.success && pending.data.subscriptionId === activeSubscription.id) {
        receiveObservation(pending.data.observation.payload)
      }
      const heartbeat = window.setInterval(() => {
        void client.share
          .heartbeat({ sessionId: session.sessionId })
          .catch(() => publish({ message: 'The location connection was lost.' }))
      }, session.heartbeatIntervalMs)
      const close = async () => {
        window.clearInterval(heartbeat)
        unsubscribe()
        try {
          await client.share.leave({ sessionId: session.sessionId })
        } catch {
          // Closing the transport still ends this local viewer session.
        }
        await messagePort.close()
      }
      viewerClosers.add(close)
      void messagePort.closed.then((result) => {
        window.clearInterval(heartbeat)
        unsubscribe()
        viewerClosers.delete(close)
        if (result.reason !== 'local') {
          publish({ message: 'Location sharing ended.' })
        }
      })
      publish({ message: 'Waiting for the first location…' })
    },
    stopShare: async (shareId) => {
      const share = shares.get(shareId)
      if (!share) return
      shares.delete(shareId)
      for (const session of share.sessions) {
        if (session.sessionId) {
          session.send(
            constellationProtocolV1.streams['share.sessions'].closed.parse({
              type: 'closed',
              sessionId: session.sessionId,
              reason: 'revoked',
            }),
          )
        }
      }
      await Promise.all([...share.sessions].map((session) => session.close()))
      publish()
      if (shares.size === 0) locationSource.stop()
    },
    stop: async () => {
      window.clearInterval(heartbeatSweep)
      unsubscribeLocationState()
      unsubscribeLocationObservation()
      locationSource.stop()
      await Promise.all([...viewerClosers].map((close) => close()))
      for (const share of shares.values()) {
        await Promise.all([...share.sessions].map((session) => session.close()))
      }
      if (handlerNode) {
        await handlerNode.unhandle(SHARE_STREAM_PROTOCOL)
        await handlerNode.stop()
      }
      shares.clear()
      received.clear()
      observers.clear()
    },
  }
}
