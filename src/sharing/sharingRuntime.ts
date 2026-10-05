import { createPortClient, createPortServer } from '@taskyon/protocol'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import type { PrivateKey } from '@libp2p/interface'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

import { projectApproximateLocation, type ApproximationState } from '../location/approximation.ts'
import type { BrowserLocationSource, BrowserLocationState } from '../location/browser.ts'
import {
  acceptNewerLocationObservation,
  type LocationObservationV1,
} from '../location/locationObservation.ts'
import {
  disclosedPrecisionFor,
  shareExpiryFor,
  VERY_COARSE_RADIUS_METERS,
  type ShareBatteryPolicy,
  type ShareDraft,
  type ShareNetworkPolicy,
} from '../shareDraft.ts'
import {
  createConstellationMessagePort,
  dialShareStream,
  startPrivateBrowserPeer,
  type ConstellationMessage,
} from './browserPeer.ts'
import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'
import { createRedemptionProof, verifyRedemptionProof } from './shareAuth.ts'
import {
  createShareInvitation,
  parseShareInvitation,
  verifyReturnOwner,
  type ShareCapability,
} from './shareLink.ts'
import {
  backgroundSharePolicy,
  sharePauseReason,
  type NetworkRestriction,
  type SharePauseState,
} from './sharePolicy.ts'
import { decryptLocationPayload, encryptLocationPayload } from './sharePayloadCrypto.ts'
import { constellationProtocolV2, SHARE_STREAM_PROTOCOL } from './shareProtocol.ts'
import { classifyTransport, type TransportKind } from './transport.ts'
import type { PrivateState, PrivateStateStore } from './privateStore.ts'
import { END_NOTICE_RETENTION_MS, retainedEndNotifications } from './shareLifecycle.ts'

const LOCATION_SENSOR_ID = 'location'
const DESCRIPTOR_REVISION = 'constellation-location-v1'
const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_TIMEOUT_MS = 35_000
const MAX_ACTIVE_SESSIONS = 128
const MAX_REDEEMED_NONCES_PER_SHARE = 1_024

export const sessionSweepReason = (
  expiresAt: number | null,
  lastHeartbeatAt: number,
  now: number,
): 'expired' | 'heartbeat-timeout' | undefined => {
  if (expiresAt !== null && now >= expiresAt) return 'expired'
  if (now - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) return 'heartbeat-timeout'
  return undefined
}

type PeerStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface ShareSummary {
  readonly shareId: string
  readonly url: string
  readonly precision: ShareDraft['precision']
  readonly battery: ShareBatteryPolicy
  readonly network: ShareNetworkPolicy
  readonly paused?: SharePauseState
  readonly lastUpdateAt?: number
  readonly expiresAt: number | null
  readonly viewerCount: number
  readonly viewers?: readonly { fingerprint: string; lastSeenAt: number; localName?: string }[]
  readonly name?: string
  readonly publication?: ShareDraft['publication']
}

export type FollowStatus = 'live' | 'delayed' | 'stale' | 'expired' | 'revoked' | 'unavailable'

export interface FollowSummary {
  readonly shareId: string
  readonly sourceName?: string
  readonly localName: string
  readonly color: string
  readonly connected: boolean
  readonly status: FollowStatus
  readonly saved: boolean
  readonly followedAt?: number
  readonly lastLocationAt?: number
  readonly updatesReceived: number
  readonly expiresAt: number | null
  readonly returnPromptSeen: boolean
  readonly endedAt?: number
}

export interface OldShareSummary {
  readonly shareId: string
  readonly name?: string
  readonly endedAt: number
  readonly reason: 'revoked' | 'expired'
}

export const followStatusFor = (options: {
  connected: boolean
  observation?: Pick<LocationObservationV1, 'capturedAt' | 'expiresAt'>
  terminal?: 'expired' | 'revoked' | 'unavailable'
  now?: number
}): FollowStatus => {
  if (options.terminal) return options.terminal
  if (!options.connected || !options.observation) return 'unavailable'
  const now = options.now ?? Date.now()
  if (now >= options.observation.expiresAt) return 'stale'
  if (now >= options.observation.capturedAt + 15_000) return 'delayed'
  return 'live'
}

export const FOLLOW_COLORS = ['#438ec9', '#8a6fc9', '#289a82', '#c0709a'] as const

export interface SharingRuntimeState {
  readonly peerStatus: PeerStatus
  readonly location: BrowserLocationState
  readonly shares: readonly ShareSummary[]
  readonly received: readonly {
    shareId: string
    observation: LocationObservationV1
    state: 'live' | 'delayed' | 'stale'
  }[]
  readonly following: readonly FollowSummary[]
  readonly returnOffers: readonly {
    shareId: string
    viewerFingerprint: string
    ownerPeerId: string
    url: string
  }[]
  readonly approvedReturnLinks: readonly string[]
  readonly oldSharing: readonly OldShareSummary[]
  readonly oldSeeing: readonly OldShareSummary[]
  readonly endNotifications: readonly {
    shareId: string
    publication: ShareDraft['publication']
    retainUntil: number
  }[]
  readonly message: string
  readonly canSave: boolean
}

export interface NetworkDiagnostics {
  readonly peerStatus: PeerStatus
  readonly sessionEvents: readonly SessionEvent[]
  readonly connections: readonly {
    role: 'viewer' | 'source' | 'other peer'
    transport: TransportKind
    direction: string
    status: string
    connectedAt?: number
    peerId: string
    remoteAddress: string
  }[]
}

export interface SessionEvent {
  readonly sequence: number
  readonly at: number
  readonly event:
    | 'stream-open'
    | 'redeem-denied'
    | 'admitted'
    | 'left'
    | 'transport-closed'
    | 'heartbeat-timeout'
    | 'heartbeat-failed'
    | 'expired'
    | 'blocked'
    | 'stopped'
  readonly activeSessions: number
}

export const appendSessionEvent = (
  events: readonly SessionEvent[],
  event: SessionEvent,
): readonly SessionEvent[] => [...events, event].slice(-32)

interface SourceSession {
  readonly peerId: string
  readonly close: () => Promise<void>
  readonly closeAfterFlush: () => Promise<void>
  readonly send: (message: ConstellationMessage) => void
  sessionId?: string
  subscriptionId?: string
  lastHeartbeatAt: number
  fingerprint?: string
}

interface SourceShare {
  readonly capability: ShareCapability
  readonly url: string
  readonly secret: Uint8Array
  readonly sourcePrivateKey?: PrivateKey
  readonly precision: ShareDraft['precision']
  readonly capacity: number
  readonly name?: string
  readonly publication: ShareDraft['publication']
  readonly battery: ShareBatteryPolicy
  readonly network: ShareNetworkPolicy
  readonly sessions: Set<SourceSession>
  readonly redeemedNonces: Set<string>
  readonly blockedPeerIds: Set<string>
  approximation?: ApproximationState
  latest?: LocationObservationV1
}

type EndedSourceShare = Pick<
  SourceShare,
  'capability' | 'url' | 'sourcePrivateKey' | 'publication'
> & {
  reason: 'revoked' | 'expired'
  endedAt: number
}

interface FollowEntry {
  readonly url: string
  readonly sourcePeerId: string
  sourceName?: string
  localName: string
  color: string
  connected: boolean
  terminal?: 'expired' | 'revoked' | 'unavailable'
  saved: boolean
  followedAt?: number
  returnPromptSeen: boolean
  endedAt?: number
  updatesReceived: number
  expiresAt: number | null
}

export const generatedFollowName = (shareId: string): string => {
  const adjectives = ['Amber', 'Bright', 'Calm', 'Gentle', 'Lucky', 'Quiet', 'Silver', 'Sunny']
  const nouns = ['Badger', 'Comet', 'Finch', 'Fox', 'Heron', 'Otter', 'Robin', 'Willow']
  let hash = 2166136261
  for (const character of shareId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return `${adjectives[(hash >>> 0) % adjectives.length]} ${nouns[((hash >>> 8) >>> 0) % nouns.length]}`
}

export const savedFollowRecords = (
  entries: readonly {
    url: string
    localName: string
    color: string
    saved: boolean
    followedAt?: number
    returnPromptSeen?: boolean
    terminal?: 'expired' | 'revoked' | 'unavailable'
    endedAt?: number
  }[],
): PrivateState['followed'] =>
  entries
    .filter((entry) => entry.saved)
    .map(({ url, localName, color, followedAt, returnPromptSeen, terminal, endedAt }) => ({
      url,
      localName,
      color,
      ...(followedAt ? { followedAt } : {}),
      ...(returnPromptSeen ? { returnPromptSeen: true } : {}),
      ...(terminal === 'expired' || terminal === 'revoked' ? { endReason: terminal } : {}),
      ...(endedAt ? { endedAt } : {}),
    }))

const viewerFingerprint = async (shareId: string, peerId: string): Promise<string> => {
  const input = new TextEncoder().encode(`${shareId}:${peerId}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return bytesToBase64Url(digest.slice(0, 6))
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

export interface SharingRuntime {
  networkDiagnostics: () => NetworkDiagnostics
  setNetworkState: (restriction: NetworkRestriction | undefined) => void
  getViewerLabel: (shareId: string, fingerprint: string) => string | undefined
  setViewerLabel: (shareId: string, fingerprint: string, name: string) => Promise<void>
  blockViewer: (shareId: string, fingerprint: string) => Promise<void>
  offerReturnShare: (followShareId: string, url: string) => Promise<void>
  dismissReturnOffer: (shareId: string, fingerprint: string) => Promise<void>
  approveReturnLink: (shareId: string) => Promise<void>
  markReturnPromptSeen: (shareId: string) => Promise<void>
  initialize: () => Promise<void>
  subscribe: (observer: (state: SharingRuntimeState) => void) => () => void
  createShare: (
    draft: ShareDraft,
    expiresAt?: number | null,
    linkBaseUrl?: string,
  ) => Promise<ShareSummary>
  acceptShare: (
    url: string,
    options?: { localName?: string; saved?: boolean; returnOwnerPeerId?: string },
  ) => Promise<void>
  saveFollowing: (shareId: string, localName: string) => Promise<void>
  stopFollowing: (shareId: string) => Promise<void>
  setFollowName: (shareId: string, name: string) => void
  setFollowColor: (shareId: string, color: string) => void
  setVisible: (visible: boolean, acquireLocation?: boolean) => void
  stopShare: (shareId: string) => Promise<void>
  stopEndNotifications: () => Promise<void>
  stop: () => Promise<void>
}

export const acceptReturnShare = async (
  runtime: Pick<SharingRuntime, 'acceptShare'>,
  offer: SharingRuntimeState['returnOffers'][number],
  isConnected: (shareId: string) => boolean,
): Promise<void> => {
  const capability = parseShareInvitation(offer.url)
  if (!isConnected(capability.shareId)) {
    await runtime.acceptShare(offer.url, { saved: true, returnOwnerPeerId: offer.ownerPeerId })
  }
  if (!isConnected(capability.shareId)) throw new Error('This return location link has ended.')
}

export const createSharingRuntime = (
  locationSource: BrowserLocationSource,
  shareBaseUrl = window.location.origin + window.location.pathname,
  store?: PrivateStateStore,
  returnShareReceiver: 'local' | 'external' = 'local',
): SharingRuntime => {
  const observers = new Set<(state: SharingRuntimeState) => void>()
  const shares = new Map<string, SourceShare>()
  const endedShares = new Map<string, EndedSourceShare>()
  const pendingRevocations = new Set<string>()
  const received = new Map<string, LocationObservationV1>()
  const followed = new Map<string, FollowEntry>()
  const viewerLabels = new Map<string, string>()
  const viewerClosers = new Map<string, () => Promise<void>>()
  const returnSenders = new Map<string, (url: string) => Promise<void>>()
  const returnOffers = new Map<
    string,
    { shareId: string; viewerFingerprint: string; ownerPeerId: string; url: string }
  >()
  const approvedReturnLinks = new Set<string>()
  const pendingReturns = new Map<string, string>()
  const oldSharing = new Map<string, OldShareSummary>()
  const oldSeeing = new Map<string, OldShareSummary>()
  const rememberLifecycleRecord = (
    history: Map<string, OldShareSummary>,
    record: OldShareSummary,
  ): void => {
    history.set(record.shareId, record)
    while (history.size > 128) {
      const oldest = [...history.values()].reduce((left, right) =>
        left.endedAt <= right.endedAt ? left : right,
      )
      history.delete(oldest.shareId)
    }
  }
  let noticeTimer: number | undefined
  const reconnecting = new Set<string>()
  const sourceNodes = new Map<string, BrowserLibp2pNode>()
  const sourceStarts = new Map<string, Promise<{ node: BrowserLibp2pNode; addresses: string[] }>>()
  let peer: Promise<{ node: BrowserLibp2pNode; addresses: string[] }> | undefined
  let handlerNode: BrowserLibp2pNode | undefined
  let visible = true
  let privateKey: PrivateKey | undefined
  let preparation: Promise<void> | undefined
  let persistence = Promise.resolve()
  let privateStateAvailable = true
  let sessionEvents: readonly SessionEvent[] = []
  let sessionEventSequence = 0
  let networkRestriction: NetworkRestriction | undefined
  let state: SharingRuntimeState = {
    peerStatus: 'offline',
    location: locationSource.getState(),
    shares: [],
    received: [],
    following: [],
    returnOffers: [],
    approvedReturnLinks: [],
    oldSharing: [],
    oldSeeing: [],
    endNotifications: [],
    message: '',
    canSave: Boolean(store),
  }

  const publish = (patch: Partial<SharingRuntimeState> = {}): void => {
    if (Object.hasOwn(patch, 'message')) {
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
      noticeTimer = undefined
      if (patch.message) {
        noticeTimer = window.setTimeout(() => {
          noticeTimer = undefined
          publish({ message: '' })
        }, 6_000)
      }
    }
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
        viewers: [...share.sessions]
          .filter((session) => session.fingerprint)
          .map((session) => {
            const localName = viewerLabels.get(`${share.capability.shareId}:${session.fingerprint}`)
            return {
              fingerprint: session.fingerprint!,
              lastSeenAt: session.lastHeartbeatAt,
              ...(localName ? { localName } : {}),
            }
          }),
        ...(share.name ? { name: share.name } : {}),
        publication: share.publication,
        battery: share.battery,
        network: share.network,
        ...(sharePauseReason(share, networkRestriction)
          ? { paused: sharePauseReason(share, networkRestriction) }
          : {}),
        ...(share.latest ? { lastUpdateAt: share.latest.capturedAt } : {}),
      })),
      received: [...received.entries()].map(([shareId, observation]) => ({
        shareId,
        observation,
        state:
          !followed.get(shareId)?.connected || now >= observation.expiresAt
            ? 'stale'
            : now >= observation.capturedAt + 15_000
              ? 'delayed'
              : 'live',
      })),
      following: [...followed.entries()].map(([shareId, entry]) => {
        const observation = received.get(shareId)
        return {
          shareId,
          sourceName: entry.sourceName,
          localName: entry.localName,
          color: entry.color,
          connected: entry.connected,
          status: followStatusFor({
            connected: entry.connected,
            observation,
            terminal:
              entry.terminal ??
              (entry.expiresAt !== null && now >= entry.expiresAt ? 'expired' : undefined),
            now,
          }),
          saved: entry.saved,
          ...(entry.followedAt ? { followedAt: entry.followedAt } : {}),
          ...(observation ? { lastLocationAt: observation.capturedAt } : {}),
          updatesReceived: entry.updatesReceived,
          expiresAt: entry.expiresAt,
          returnPromptSeen: entry.returnPromptSeen,
          ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
        }
      }),
      endNotifications: [...endedShares.values()].map((share) => ({
        shareId: share.capability.shareId,
        publication: share.publication,
        retainUntil: share.endedAt + END_NOTICE_RETENTION_MS,
      })),
      returnOffers: [...returnOffers.values()],
      approvedReturnLinks: [...approvedReturnLinks],
      oldSharing: [...oldSharing.values()].sort((left, right) => right.endedAt - left.endedAt),
      oldSeeing: [...oldSeeing.values()].sort((left, right) => right.endedAt - left.endedAt),
    }
    observers.forEach((observer) => observer(state))
  }

  const snapshot = (): PrivateState => {
    if (!privateKey) throw new Error('Protected peer identity is unavailable.')
    return {
      version: 1,
      privateKey: bytesToBase64Url(privateKeyToProtobuf(privateKey)),
      shares: [...shares.values()].map((share) => ({
        url: share.url,
        ...(share.sourcePrivateKey
          ? {
              sourcePrivateKey: bytesToBase64Url(privateKeyToProtobuf(share.sourcePrivateKey)),
            }
          : {}),
        precision: share.precision,
        capacity: share.capacity,
        name: share.name,
        publication: share.publication,
        battery: share.battery,
        network: share.network,
        blockedPeerIds: [...share.blockedPeerIds],
        approximation: share.approximation,
      })),
      endedShares: [...endedShares.values()].map((share) => ({
        url: share.url,
        ...(share.sourcePrivateKey
          ? {
              sourcePrivateKey: bytesToBase64Url(privateKeyToProtobuf(share.sourcePrivateKey)),
            }
          : {}),
        publication: share.publication,
        reason: share.reason,
        endedAt: share.endedAt,
      })),
      followed: savedFollowRecords([...followed.values()]),
      approvedReturnLinks: [...approvedReturnLinks],
      pendingReturns: [...pendingReturns].map(([shareId, url]) => ({ shareId, url })),
      returnOffers: [...returnOffers.values()],
      oldSharing: [...oldSharing.values()],
      oldSeeing: [...oldSeeing.values()],
      viewerLabels: [...viewerLabels].map(([key, name]) => {
        const separator = key.indexOf(':')
        return { shareId: key.slice(0, separator), fingerprint: key.slice(separator + 1), name }
      }),
    }
  }

  const persist = (traceFollow = false): Promise<void> => {
    if (!store) return Promise.resolve()
    if (!privateStateAvailable) {
      return Promise.reject(
        new Error('Protected storage is unavailable; this location can only be previewed.'),
      )
    }
    const saved = snapshot()
    persistence = persistence
      .catch(() => undefined)
      .then(async () => {
        if (traceFollow) console.info('[constellation-persist] native-save-start')
        await store.save(saved)
        if (traceFollow) console.info('[constellation-persist] native-save-complete')
      })
    return persistence
  }

  const useEphemeralIdentity = async (): Promise<void> => {
    privateStateAvailable = false
    privateKey ??= await generateKeyPair('Ed25519')
    publish({ canSave: false, message: 'Protected storage is unavailable; preview only.' })
  }

  const prepareState = (): Promise<void> => {
    if (!store) return Promise.resolve()
    if (!preparation) {
      preparation = (async () => {
        let saved: PrivateState | undefined
        try {
          saved = await store.load()
        } catch {
          await useEphemeralIdentity()
          return
        }
        privateKey = saved
          ? privateKeyFromProtobuf(base64UrlToBytes(saved.privateKey))
          : await generateKeyPair('Ed25519')
        if (!saved) {
          try {
            await persist()
          } catch {
            await useEphemeralIdentity()
            return
          }
        }
        let changedProtectedState = false
        for (const record of saved?.shares ?? []) {
          try {
            const capability = parseShareInvitation(record.url)
            shares.set(capability.shareId, {
              capability,
              url: record.url,
              secret: base64UrlToBytes(capability.secret),
              ...(record.sourcePrivateKey
                ? {
                    sourcePrivateKey: privateKeyFromProtobuf(
                      base64UrlToBytes(record.sourcePrivateKey),
                    ),
                  }
                : {}),
              precision: record.precision,
              capacity: record.capacity,
              name: record.name,
              publication: record.publication,
              ...backgroundSharePolicy(
                record.publication,
                record.battery ?? 'balanced',
                record.network ?? 'always',
              ),
              sessions: new Set(),
              redeemedNonces: new Set(),
              blockedPeerIds: new Set(record.blockedPeerIds ?? []),
              approximation: record.approximation,
            })
          } catch {
            changedProtectedState = true
            try {
              const expired = parseShareInvitation(record.url, 0)
              if (expired.expiresAt !== null && expired.expiresAt <= Date.now()) {
                endedShares.set(expired.shareId, {
                  capability: expired,
                  url: record.url,
                  publication: record.publication,
                  reason: 'expired',
                  endedAt: expired.expiresAt,
                  ...(record.sourcePrivateKey
                    ? {
                        sourcePrivateKey: privateKeyFromProtobuf(
                          base64UrlToBytes(record.sourcePrivateKey),
                        ),
                      }
                    : {}),
                })
                rememberLifecycleRecord(oldSharing, {
                  shareId: expired.shareId,
                  ...(record.name ? { name: record.name } : {}),
                  reason: 'expired',
                  endedAt: expired.expiresAt,
                })
              }
            } catch {
              // Invalid links remain discarded without retaining their contents.
            }
          }
        }
        const retained = retainedEndNotifications(saved?.endedShares ?? [])
        changedProtectedState ||= retained.length !== (saved?.endedShares?.length ?? 0)
        for (const record of retained) {
          try {
            const capability = parseShareInvitation(record.url, 0)
            if (shares.has(capability.shareId)) {
              changedProtectedState = true
              continue
            }
            endedShares.set(capability.shareId, {
              capability,
              url: record.url,
              publication: record.publication,
              reason: record.reason,
              endedAt: record.endedAt,
              ...(record.sourcePrivateKey
                ? {
                    sourcePrivateKey: privateKeyFromProtobuf(
                      base64UrlToBytes(record.sourcePrivateKey),
                    ),
                  }
                : {}),
            })
          } catch {
            changedProtectedState = true
          }
        }
        for (const record of saved?.followed ?? []) {
          try {
            const capability = parseShareInvitation(record.url)
            followed.set(capability.shareId, {
              url: record.url,
              sourcePeerId: capability.sourcePeerId,
              localName: record.localName,
              color: record.color,
              connected: false,
              saved: true,
              followedAt: record.followedAt,
              returnPromptSeen: record.returnPromptSeen ?? false,
              ...(record.endReason ? { terminal: record.endReason } : {}),
              ...(record.endedAt ? { endedAt: record.endedAt } : {}),
              updatesReceived: 0,
              expiresAt: capability.expiresAt,
            })
          } catch {
            try {
              const expired = parseShareInvitation(record.url, 0)
              if (expired.expiresAt !== null && expired.expiresAt <= Date.now()) {
                const endedAt = expired.expiresAt
                followed.set(expired.shareId, {
                  url: record.url,
                  sourcePeerId: expired.sourcePeerId,
                  localName: record.localName,
                  color: record.color,
                  connected: false,
                  saved: true,
                  returnPromptSeen: record.returnPromptSeen ?? true,
                  terminal: 'expired',
                  endedAt,
                  updatesReceived: 0,
                  expiresAt: expired.expiresAt,
                })
                rememberLifecycleRecord(oldSeeing, {
                  shareId: expired.shareId,
                  name: record.localName,
                  reason: 'expired',
                  endedAt,
                })
                changedProtectedState = true
              }
            } catch {
              // Invalid links are not restored.
            }
          }
        }
        for (const record of saved?.viewerLabels ?? []) {
          viewerLabels.set(`${record.shareId}:${record.fingerprint}`, record.name)
        }
        for (const shareId of saved?.approvedReturnLinks ?? []) approvedReturnLinks.add(shareId)
        for (const { shareId, url } of saved?.pendingReturns ?? []) pendingReturns.set(shareId, url)
        for (const offer of saved?.returnOffers ?? []) {
          returnOffers.set(`${offer.shareId}:${offer.viewerFingerprint}`, offer)
        }
        for (const record of saved?.oldSharing ?? []) oldSharing.set(record.shareId, record)
        for (const record of saved?.oldSeeing ?? []) oldSeeing.set(record.shareId, record)
        for (const shareId of approvedReturnLinks) {
          if (shares.has(shareId)) continue
          approvedReturnLinks.delete(shareId)
          changedProtectedState = true
        }
        for (const [key, offer] of returnOffers) {
          if (shares.has(offer.shareId)) continue
          returnOffers.delete(key)
          changedProtectedState = true
        }
        const prunedEndIds = pruneEndNotifications()
        changedProtectedState ||= prunedEndIds.length > 0
        if (saved && changedProtectedState) await persist()
        const currentLocation = locationSource.getState()
        if (
          (currentLocation.status === 'live' || currentLocation.status === 'delayed') &&
          currentLocation.observation.expiresAt > Date.now()
        ) {
          let changed = false
          for (const share of shares.values()) {
            if (updateShareLocation(share, currentLocation.observation)) changed = true
          }
          if (changed) {
            void persist().catch(() =>
              publish({ message: 'Private share state could not be saved.' }),
            )
          }
        }
        publish()
      })().catch((error) => {
        preparation = undefined
        publish({
          peerStatus: 'error',
          message: error instanceof Error ? error.message : 'Protected shares could not be opened.',
        })
        throw error
      })
    }
    return preparation
  }

  const recordSessionEvent = (event: SessionEvent['event']): void => {
    sessionEvents = appendSessionEvent(sessionEvents, {
      sequence: ++sessionEventSequence,
      at: Date.now(),
      event,
      activeSessions: [...shares.values()].reduce((count, share) => count + share.sessions.size, 0),
    })
  }

  const removeSession = (session: SourceSession, reason: SessionEvent['event']): void => {
    let removed = false
    for (const share of shares.values()) {
      if (share.sessions.delete(session)) removed = true
    }
    if (removed) recordSessionEvent(reason)
    publish()
  }

  const encryptedObservationMessage = async (
    share: SourceShare,
    subscriptionId: string,
  ): Promise<ConstellationMessage | undefined> => {
    if (sharePauseReason(share, networkRestriction)) return undefined
    if (!share.latest) return undefined
    const observation = share.latest
    const payload = await encryptLocationPayload(
      share.secret,
      share.capability.shareId,
      observation,
    )
    return constellationProtocolV2.streams['sensor.observations'].observation.parse({
      type: 'observation',
      subscriptionId,
      observation: {
        sensorId: LOCATION_SENSOR_ID,
        descriptorRevision: DESCRIPTOR_REVISION,
        sourcePrincipal: share.capability.sourcePeerId,
        sequence: observation.sequence,
        capturedAt: observation.capturedAt,
        expiresAt: observation.expiresAt,
        payload,
      },
    })
  }

  const handleIncomingStream = (
    stream: Parameters<typeof createConstellationMessagePort>[0],
    connection: { remotePeer: { toString: () => string } },
    expectedShareId?: string,
  ): void => {
    recordSessionEvent('stream-open')
    const messagePort = createConstellationMessagePort(stream)
    const session: SourceSession = {
      peerId: connection.remotePeer.toString(),
      close: () => messagePort.close(),
      closeAfterFlush: () => messagePort.closeAfterFlush(),
      send: messagePort.port.send,
      lastHeartbeatAt: Date.now(),
    }
    let authorizedShare: SourceShare | undefined
    const stopServer = createPortServer(
      messagePort.port,
      constellationProtocolV2,
      {
        share: {
          redeem: async ({ shareId, viewerNonce, proof }) => {
            const ended = endedShares.get(shareId)
            if (
              ended &&
              !pendingRevocations.has(shareId) &&
              ended.endedAt + END_NOTICE_RETENTION_MS > Date.now() &&
              (expectedShareId === undefined
                ? !ended.sourcePrivateKey
                : expectedShareId === shareId) &&
              (await verifyRedemptionProof(
                base64UrlToBytes(ended.capability.secret),
                {
                  shareId,
                  sourcePeerId: ended.capability.sourcePeerId,
                  viewerPeerId: session.peerId,
                  viewerNonce,
                },
                proof,
              ))
            ) {
              return { ended: true as const, reason: ended.reason, endedAt: ended.endedAt }
            }
            const candidate = shares.get(shareId)
            const servedByThisPeer =
              candidate &&
              (expectedShareId === undefined
                ? candidate.sourcePrivateKey === undefined
                : candidate.capability.shareId === expectedShareId)
            const permitted =
              servedByThisPeer &&
              !candidate.redeemedNonces.has(viewerNonce) &&
              !candidate.blockedPeerIds.has(session.peerId) &&
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
            if (!candidate || !permitted || candidate.blockedPeerIds.has(session.peerId)) {
              recordSessionEvent('redeem-denied')
              throw new Error('Share access denied.')
            }
            authorizedShare = candidate
            session.sessionId = randomToken()
            session.lastHeartbeatAt = Date.now()
            session.fingerprint = await viewerFingerprint(shareId, session.peerId)
            rememberRedeemedNonce(candidate.redeemedNonces, viewerNonce)
            candidate.sessions.add(session)
            recordSessionEvent('admitted')
            publish()
            return {
              sessionId: session.sessionId,
              expiresAt: candidate.capability.expiresAt,
              precision: disclosedPrecisionFor(candidate.precision),
              ...(candidate.name ? { sourceName: candidate.name } : {}),
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
            removeSession(session, 'left')
          },
          offerReturn: async ({ sessionId, url, ownerPeerId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (session.sessionId !== sessionId || !share.sessions.has(session)) {
              throw new Error('Share access denied.')
            }
            const offered = parseShareInvitation(url)
            if (
              !session.fingerprint ||
              offered.shareId === share.capability.shareId ||
              ownerPeerId !== session.peerId ||
              !(await verifyReturnOwner(offered, session.peerId))
            ) {
              throw new Error('Invalid return share.')
            }
            const key = `${share.capability.shareId}:${session.fingerprint}`
            const offer = {
              shareId: share.capability.shareId,
              viewerFingerprint: session.fingerprint,
              ownerPeerId: session.peerId,
              url,
            }
            returnOffers.set(key, offer)
            await persist()
            if (approvedReturnLinks.has(share.capability.shareId)) {
              try {
                if (await acceptPendingReturn(key, offer)) {
                  publish({ message: 'A viewer shared back and was accepted automatically.' })
                  return
                }
              } catch {
                // Preserve the queued offer for an explicit retry.
              }
            }
            publish()
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
          subscribe: async ({ sensorId }) => {
            const share = requireAuthorized(session, authorizedShare)
            if (sensorId !== LOCATION_SENSOR_ID) throw new Error('Sensor access denied.')
            session.subscriptionId = randomToken()
            const initial = await encryptedObservationMessage(share, session.subscriptionId)
            if (initial) session.send(initial)
            if (
              (visible || share.publication === 'background') &&
              !sharePauseReason(share, networkRestriction)
            ) {
              locationSource.refresh()
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
      removeSession(session, 'transport-closed')
    })
  }

  const startPeer = async () => {
    if (!peer) {
      publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
      peer = startPrivateBrowserPeer(privateKey)
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
  const startSourcePeer = (
    share: Pick<SourceShare, 'capability' | 'sourcePrivateKey'>,
  ): Promise<{ node: BrowserLibp2pNode; addresses: string[] }> => {
    if (!share.sourcePrivateKey) return startPeer()
    const shareId = share.capability.shareId
    const existing = sourceStarts.get(shareId)
    if (existing) return existing

    publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
    const starting = startPrivateBrowserPeer(share.sourcePrivateKey)
      .then(async (started) => {
        await started.node.handle(
          SHARE_STREAM_PROTOCOL,
          (stream, connection) => handleIncomingStream(stream, connection, shareId),
          { runOnLimitedConnection: true },
        )
        sourceNodes.set(shareId, started.node)
        publish({ peerStatus: 'online', message: '' })
        return started
      })
      .catch((error) => {
        sourceStarts.delete(shareId)
        publish({
          peerStatus: 'error',
          message: error instanceof Error ? error.message : 'P2P connection failed.',
        })
        throw error
      })
    sourceStarts.set(shareId, starting)
    return starting
  }

  const stopSourcePeer = async (shareId: string): Promise<void> => {
    const starting = sourceStarts.get(shareId)
    sourceStarts.delete(shareId)
    let node = sourceNodes.get(shareId)
    if (!node && starting) {
      try {
        node = (await starting).node
      } catch {
        return
      }
    }
    sourceNodes.delete(shareId)
    if (!node) return
    await node.unhandle(SHARE_STREAM_PROTOCOL).catch(() => undefined)
    await node.stop()
  }

  const pruneEndNotifications = (): string[] => {
    const retained = new Set(
      retainedEndNotifications([...endedShares.values()]).map((share) => share.capability.shareId),
    )
    const removed = [...endedShares.keys()].filter((shareId) => !retained.has(shareId))
    removed.forEach((shareId) => endedShares.delete(shareId))
    return removed
  }

  const rememberEndNotification = (
    share: SourceShare,
    reason: 'revoked' | 'expired',
    endedAt: number,
  ): void => {
    endedShares.set(share.capability.shareId, {
      capability: share.capability,
      url: share.url,
      sourcePrivateKey: share.sourcePrivateKey,
      publication: share.publication,
      reason,
      endedAt,
    })
  }

  const endFollowing = (
    shareId: string,
    reason: 'revoked' | 'expired',
    endedAt: number,
    name?: string,
  ): void => {
    const entry = followed.get(shareId)
    if (entry) {
      entry.connected = false
      entry.terminal = reason
      entry.endedAt = endedAt
    }
    received.delete(shareId)
    pendingReturns.delete(shareId)
    rememberLifecycleRecord(oldSeeing, { shareId, name: entry?.localName ?? name, reason, endedAt })
  }

  const acceptPendingReturn = async (
    key: string,
    offer: SharingRuntimeState['returnOffers'][number],
  ): Promise<boolean> => {
    if (returnShareReceiver === 'external') return false
    const capability = parseShareInvitation(offer.url)
    if (oldSeeing.has(capability.shareId) || followed.get(capability.shareId)?.terminal) {
      throw new Error('This return location link has ended.')
    }
    await acceptReturnShare(runtime, offer, (shareId) => Boolean(followed.get(shareId)?.connected))
    if (returnOffers.get(key) !== offer) return false
    returnOffers.delete(key)
    try {
      await persist()
    } catch (error) {
      returnOffers.set(key, offer)
      throw error
    }
    publish()
    return true
  }

  const ensurePeer = async () => {
    await prepareState()
    return startPeer()
  }

  const updateShareLocation = (share: SourceShare, exact: LocationObservationV1): boolean => {
    if (sharePauseReason(share, networkRestriction)) return false
    if (share.precision === 'exact') {
      share.latest = exact
      return false
    }
    const projected = projectApproximateLocation(
      exact,
      share.approximation,
      undefined,
      share.precision === 'very-coarse' ? VERY_COARSE_RADIUS_METERS : undefined,
    )
    const changed =
      !share.approximation ||
      Object.entries(projected.state).some(
        ([key, value]) => value !== share.approximation?.[key as keyof ApproximationState],
      )
    share.approximation = projected.state
    share.latest = projected.observation
    return changed
  }

  const unsubscribeLocationState = locationSource.subscribeState((location) =>
    publish({ location }),
  )
  const unsubscribeLocationObservation = locationSource.subscribeObservation((exact) => {
    let privateStateChanged = false
    for (const share of shares.values()) {
      if (!visible && share.publication === 'foreground') continue
      if (updateShareLocation(share, exact)) privateStateChanged = true
      for (const session of share.sessions) {
        if (!session.subscriptionId || !share.latest) continue
        void encryptedObservationMessage(share, session.subscriptionId)
          .then((message) => {
            if (message) session.send(message)
          })
          .catch(() => publish({ message: 'Location encryption failed.' }))
      }
    }
    if (privateStateChanged) {
      void persist().catch(() => publish({ message: 'Private share state could not be saved.' }))
    }
  })

  const heartbeatSweep = window.setInterval(() => {
    const now = Date.now()
    for (const share of shares.values()) {
      const expired = share.capability.expiresAt !== null && now >= share.capability.expiresAt
      for (const session of [...share.sessions]) {
        const reason = sessionSweepReason(share.capability.expiresAt, session.lastHeartbeatAt, now)
        if (reason) {
          if (reason === 'expired' && session.sessionId) {
            session.send(
              constellationProtocolV2.streams['share.sessions'].closed.parse({
                type: 'closed',
                sessionId: session.sessionId,
                reason: 'expired',
              }),
            )
          }
          removeSession(session, reason)
          void (reason === 'expired' ? session.closeAfterFlush() : session.close())
        }
      }
      if (expired) {
        const endedAt = share.capability.expiresAt ?? now
        rememberLifecycleRecord(oldSharing, {
          shareId: share.capability.shareId,
          ...(share.name ? { name: share.name } : {}),
          reason: 'expired',
          endedAt,
        })
        shares.delete(share.capability.shareId)
        rememberEndNotification(share, 'expired', endedAt)
        const prunedEndIds = pruneEndNotifications()
        if (!shares.size) locationSource.stop()
        approvedReturnLinks.delete(share.capability.shareId)
        for (const key of returnOffers.keys()) {
          if (key.startsWith(`${share.capability.shareId}:`)) returnOffers.delete(key)
        }
        void Promise.all([persist(), ...prunedEndIds.map(stopSourcePeer)]).catch(() =>
          publish({ message: 'Expired share state could not be saved.' }),
        )
      }
    }

    const prunedEndIds = pruneEndNotifications()
    if (prunedEndIds.length) {
      void Promise.all([persist(), ...prunedEndIds.map(stopSourcePeer)]).catch(() =>
        publish({ message: 'Ended-link notice state could not be saved.' }),
      )
    }
    let pendingReturnStateChanged = false
    for (const [shareId, url] of pendingReturns) {
      const entry = followed.get(shareId)
      try {
        parseShareInvitation(url, now)
        if (entry && !entry.terminal && (entry.expiresAt === null || now < entry.expiresAt))
          continue
      } catch {
        // Expired return links cannot be delivered later.
      }
      pendingReturns.delete(shareId)
      pendingReturnStateChanged = true
    }
    for (const [shareId, entry] of followed) {
      if (
        entry.expiresAt !== null &&
        now >= entry.expiresAt &&
        entry.terminal !== 'expired' &&
        entry.terminal !== 'revoked'
      ) {
        endFollowing(shareId, 'expired', entry.expiresAt)
        void viewerClosers.get(shareId)?.()
        void persist()
        continue
      }
      if (returnShareReceiver === 'external') continue
      if (entry.connected || viewerClosers.has(shareId) || reconnecting.has(shareId)) continue
      if (entry.terminal) continue
      try {
        parseShareInvitation(entry.url, now)
      } catch {
        entry.terminal =
          entry.expiresAt !== null && now >= entry.expiresAt ? 'expired' : 'unavailable'
        if (entry.terminal === 'expired') {
          entry.endedAt = entry.expiresAt ?? now
          received.delete(shareId)
          rememberLifecycleRecord(oldSeeing, {
            shareId,
            name: entry.localName,
            reason: 'expired',
            endedAt: entry.endedAt,
          })
          void persist()
        }
        continue
      }
      reconnecting.add(shareId)
      void runtime
        .acceptShare(entry.url, { localName: entry.localName, saved: entry.saved })
        .catch(() => undefined)
        .finally(() => reconnecting.delete(shareId))
    }
    if (pendingReturnStateChanged) void persist()
    publish()
  }, HEARTBEAT_INTERVAL_MS)

  const runtime: SharingRuntime = {
    offerReturnShare: async (followShareId, url) => {
      await prepareState()
      const follow = followed.get(followShareId)
      if (!follow || follow.terminal || oldSeeing.has(followShareId)) {
        throw new Error('This location is no longer followed.')
      }
      const capability = parseShareInvitation(url)
      const { node } = await ensurePeer()
      if (!(await verifyReturnOwner(capability, node.peerId.toString()))) {
        throw new Error('This return link cannot prove which viewer created it.')
      }
      const send = returnSenders.get(followShareId)
      if (send) {
        await send(url)
        return
      }
      pendingReturns.set(followShareId, url)
      try {
        await persist()
      } catch (error) {
        pendingReturns.delete(followShareId)
        throw error
      }
      publish({ message: 'Return link queued until the original sharer reconnects.' })
    },
    dismissReturnOffer: async (shareId, fingerprint) => {
      const key = `${shareId}:${fingerprint}`
      const offer = returnOffers.get(key)
      if (!offer) return
      returnOffers.delete(key)
      try {
        await persist()
      } catch (error) {
        returnOffers.set(key, offer)
        throw error
      }
      publish()
    },
    approveReturnLink: async (shareId) => {
      await prepareState()
      if (!shares.has(shareId)) throw new Error('This share is no longer active.')
      const wasApproved = approvedReturnLinks.has(shareId)
      approvedReturnLinks.add(shareId)
      try {
        await persist()
      } catch (error) {
        if (!wasApproved) approvedReturnLinks.delete(shareId)
        throw error
      }
      const pending = [...returnOffers.entries()].filter(([, offer]) => offer.shareId === shareId)
      let failed = false
      for (const [key, offer] of pending) {
        try {
          await acceptPendingReturn(key, offer)
        } catch {
          failed = true
        }
      }
      if (failed)
        publish({ message: 'Group approval saved. Some return links need another attempt.' })
      publish()
    },
    markReturnPromptSeen: async (shareId) => {
      await prepareState()
      const entry = followed.get(shareId)
      if (!entry || entry.returnPromptSeen) return
      entry.returnPromptSeen = true
      await persist()
      publish()
    },
    getViewerLabel: (shareId, fingerprint) => viewerLabels.get(`${shareId}:${fingerprint}`),
    setViewerLabel: async (shareId, fingerprint, name) => {
      await prepareState()
      const key = `${shareId}:${fingerprint}`
      const previous = viewerLabels.get(key)
      const next = name.trim().slice(0, 32)
      if (next) viewerLabels.set(key, next)
      else viewerLabels.delete(key)
      if (viewerLabels.size > 1_024) {
        if (previous) viewerLabels.set(key, previous)
        else viewerLabels.delete(key)
        throw new Error('Too many saved device names.')
      }
      try {
        await persist()
      } catch (error) {
        if (previous) viewerLabels.set(key, previous)
        else viewerLabels.delete(key)
        throw error
      }
      publish()
    },
    blockViewer: async (shareId, fingerprint) => {
      await prepareState()
      const share = shares.get(shareId)
      if (!share) throw new Error('This share is no longer available.')
      const sessions = [...share.sessions].filter((session) => session.fingerprint === fingerprint)
      if (sessions.length === 0) throw new Error('This device is no longer connected.')
      const peerIds = [...new Set(sessions.map((session) => session.peerId))]
      if (share.blockedPeerIds.size + peerIds.length > 128) {
        throw new Error('Too many blocked devices on this link; revoke the link instead.')
      }
      for (const peerId of peerIds) share.blockedPeerIds.add(peerId)
      try {
        await persist()
      } catch (error) {
        for (const peerId of peerIds) share.blockedPeerIds.delete(peerId)
        throw error
      }
      for (const session of sessions) {
        share.sessions.delete(session)
        if (session.sessionId) {
          session.send(
            constellationProtocolV2.streams['share.sessions'].closed.parse({
              type: 'closed',
              sessionId: session.sessionId,
              reason: 'revoked',
            }),
          )
        }
      }
      recordSessionEvent('blocked')
      publish()
      await Promise.all(sessions.map((session) => session.closeAfterFlush()))
    },
    setNetworkState: (restriction) => {
      if (restriction === networkRestriction) return
      networkRestriction = restriction
      publish()
    },
    networkDiagnostics: () => ({
      peerStatus: state.peerStatus,
      sessionEvents,
      connections: [
        ...new Set([...(handlerNode ? [handlerNode] : []), ...sourceNodes.values()]),
      ].flatMap((node) =>
        node.getConnections().map((connection) => {
          const peerId = connection.remotePeer.toString()
          const address = connection.remoteAddr.toString()
          const viewer = [...shares.values()].some((share) =>
            [...share.sessions].some((session) => session.peerId === peerId),
          )
          const source = [...followed.values()].some((entry) => entry.sourcePeerId === peerId)
          let role: NetworkDiagnostics['connections'][number]['role'] = 'other peer'
          if (viewer) role = 'viewer'
          else if (source) role = 'source'
          return {
            role,
            transport: classifyTransport(address),
            direction: connection.direction,
            status: connection.status,
            peerId,
            remoteAddress: address,
            ...(connection.timeline.open ? { connectedAt: connection.timeline.open } : {}),
          }
        }),
      ),
    }),
    initialize: async () => {
      await prepareState()
      if (shares.size > 0 || endedShares.size > 0) {
        const restoredShares = [...shares.values(), ...endedShares.values()]
        if (restoredShares.some((share) => !share.sourcePrivateKey)) await startPeer()
        await Promise.all(
          restoredShares
            .filter((share) => share.sourcePrivateKey)
            .map((share) => startSourcePeer(share)),
        )
        if (
          shares.size &&
          (visible || [...shares.values()].some((share) => share.publication === 'background'))
        ) {
          locationSource.start()
        }
      }
      const pending = [...followed.values()].filter(
        (entry) => returnShareReceiver === 'local' && !entry.connected && !entry.terminal,
      )
      void Promise.allSettled(
        pending.map((entry) =>
          runtime.acceptShare(entry.url, { localName: entry.localName, saved: entry.saved }),
        ),
      )
    },
    subscribe: (observer) => {
      observers.add(observer)
      observer(state)
      return () => observers.delete(observer)
    },
    createShare: async (
      draft,
      expiresAt = shareExpiryFor(draft, Date.now()),
      linkBaseUrl = shareBaseUrl,
    ) => {
      await prepareState()
      publish({ peerStatus: 'connecting', message: 'Connecting to the P2P network…' })
      const sourcePrivateKey = await generateKeyPair('Ed25519')
      const started = await startPrivateBrowserPeer(sourcePrivateKey)
      const invitation = await createShareInvitation({
        baseUrl: linkBaseUrl,
        sourcePeerId: started.node.peerId.toString(),
        addresses: started.addresses,
        expiresAt,
        ownerPrivateKey: privateKey,
      })
      const share: SourceShare = {
        capability: invitation.capability,
        url: invitation.url,
        secret: base64UrlToBytes(invitation.capability.secret),
        sourcePrivateKey,
        precision: draft.precision,
        capacity: capacityFor(draft),
        ...(draft.name ? { name: draft.name } : {}),
        publication: draft.publication,
        ...backgroundSharePolicy(draft.publication, draft.battery, draft.network),
        sessions: new Set(),
        redeemedNonces: new Set(),
        blockedPeerIds: new Set(),
      }
      shares.set(share.capability.shareId, share)
      try {
        await started.node.handle(
          SHARE_STREAM_PROTOCOL,
          (stream, connection) =>
            handleIncomingStream(stream, connection, share.capability.shareId),
          { runOnLimitedConnection: true },
        )
        sourceNodes.set(share.capability.shareId, started.node)
        sourceStarts.set(share.capability.shareId, Promise.resolve(started))
        publish({ peerStatus: 'online', message: '' })
      } catch (error) {
        shares.delete(share.capability.shareId)
        await started.node.stop()
        throw error
      }
      const currentLocation = locationSource.getState()
      if (
        (currentLocation.status === 'live' || currentLocation.status === 'delayed') &&
        currentLocation.observation.expiresAt > Date.now()
      ) {
        updateShareLocation(share, currentLocation.observation)
      }
      try {
        await persist()
      } catch (error) {
        shares.delete(share.capability.shareId)
        await stopSourcePeer(share.capability.shareId)
        throw error
      }
      if (visible || draft.publication === 'background') locationSource.start()
      publish()
      return state.shares.find(({ shareId }) => shareId === share.capability.shareId)!
    },
    acceptShare: async (url, options = {}) => {
      if (returnShareReceiver === 'external') {
        throw new Error('Returned locations belong to the foreground receiver.')
      }
      if (!store && options.saved !== false) {
        throw new Error('Protected storage is not configured; preview only.')
      }
      await prepareState()
      const capability = parseShareInvitation(url)
      if (followed.get(capability.shareId)?.terminal || oldSeeing.has(capability.shareId)) {
        throw new Error('This location link has ended.')
      }
      if (
        options.returnOwnerPeerId &&
        !(await verifyReturnOwner(capability, options.returnOwnerPeerId))
      ) {
        throw new Error('This return link was not created by the connected viewer.')
      }
      if (followed.get(capability.shareId)?.connected) {
        throw new Error('Already following this link.')
      }
      const { node } = await ensurePeer()
      const existingConnections = node
        .getConnections()
        .filter(
          (connection) =>
            connection.status === 'open' &&
            connection.remotePeer.toString() === capability.sourcePeerId,
        )
      const stream = await dialShareStream(
        node,
        capability.addresses,
        SHARE_STREAM_PROTOCOL,
        existingConnections,
      )
      const messagePort = createConstellationMessagePort(stream)
      const client = createPortClient(messagePort.port, constellationProtocolV2)
      const previousFollow = followed.get(capability.shareId)
      const previousObservation = received.get(capability.shareId)
      let earlyClosedMessage: ConstellationMessage | undefined
      const stopBufferingClose = messagePort.port.receive((message) => {
        if (constellationProtocolV2.streams['share.sessions'].closed.safeParse(message).success)
          earlyClosedMessage = message
      })
      try {
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
        })
        if ('ended' in session) {
          endFollowing(
            capability.shareId,
            session.reason,
            session.endedAt,
            options.localName ?? generatedFollowName(capability.shareId),
          )
          await persist()
          await messagePort.close()
          publish({
            message:
              session.reason === 'revoked'
                ? 'The sender revoked this location link.'
                : 'This location link expired.',
          })
          throw new Error('This location link has ended.')
        }
        const existing = followed.get(capability.shareId)
        const existingPeer = [...followed.values()].find(
          (entry) => entry.sourcePeerId === capability.sourcePeerId,
        )
        followed.set(capability.shareId, {
          url,
          sourcePeerId: capability.sourcePeerId,
          sourceName: session.sourceName,
          localName:
            existing?.localName ??
            options.localName?.trim() ??
            session.sourceName ??
            generatedFollowName(capability.shareId),
          color:
            existing?.color ??
            existingPeer?.color ??
            FOLLOW_COLORS[followed.size % FOLLOW_COLORS.length]!,
          connected: true,
          saved: existing?.saved ?? options.saved ?? true,
          followedAt: existing ? existing.followedAt : Date.now(),
          returnPromptSeen: existing?.returnPromptSeen ?? Boolean(options.returnOwnerPeerId),
          updatesReceived: existing?.updatesReceived ?? 0,
          expiresAt: capability.expiresAt,
        })
        const activeSubscription: { id?: string } = {}
        let pendingObservation: unknown
        let awaitingFirstObservation = true
        const receiveObservation = async (envelope: {
          sequence: number
          capturedAt: number
          expiresAt: number
          payload: unknown
        }): Promise<void> => {
          try {
            const observation = await decryptLocationPayload(
              base64UrlToBytes(capability.secret),
              capability.shareId,
              envelope.payload,
            )
            if (
              observation.sequence !== envelope.sequence ||
              observation.capturedAt !== envelope.capturedAt ||
              observation.expiresAt !== envelope.expiresAt
            ) {
              throw new Error('Location envelope metadata does not match its encrypted payload.')
            }
            const current = received.get(capability.shareId)
            const newSource = awaitingFirstObservation && current?.sourceId !== observation.sourceId
            if (!newSource && !acceptNewerLocationObservation(current, observation)) return
            awaitingFirstObservation = false
            received.set(capability.shareId, observation)
            const entry = followed.get(capability.shareId)
            if (entry) entry.updatesReceived += 1
            publish({ message: '' })
          } catch {
            // Invalid or unauthenticated location payloads are ignored without retaining their data.
          }
        }
        const receiveMessage = (message: ConstellationMessage): void => {
          const closed = constellationProtocolV2.streams['share.sessions'].closed.safeParse(message)
          if (closed.success && closed.data.sessionId === session.sessionId) {
            const entry = followed.get(capability.shareId)
            if (entry) {
              entry.connected = false
              if (closed.data.reason === 'expired' || closed.data.reason === 'revoked') {
                entry.terminal = closed.data.reason
              }
            }
            if (entry && (entry.terminal === 'expired' || entry.terminal === 'revoked')) {
              endFollowing(
                capability.shareId,
                entry.terminal,
                entry.terminal === 'expired' ? (entry.expiresAt ?? Date.now()) : Date.now(),
              )
              void persist().catch(() =>
                publish({ message: 'Ended location history could not be saved.' }),
              )
            }
            publish({
              message:
                closed.data.reason === 'expired'
                  ? 'This location link expired.'
                  : closed.data.reason === 'revoked'
                    ? 'The sender revoked your access to this location.'
                    : 'The location connection closed. Reconnecting…',
            })
            void messagePort.close()
            return
          }
          const parsed =
            constellationProtocolV2.streams['sensor.observations'].observation.safeParse(message)
          if (!parsed.success) return
          if (!activeSubscription.id) {
            pendingObservation = parsed.data
            return
          }
          if (parsed.data.subscriptionId === activeSubscription.id) {
            void receiveObservation(parsed.data.observation)
          }
        }
        const unsubscribe = messagePort.port.receive(receiveMessage)
        stopBufferingClose()
        if (earlyClosedMessage) receiveMessage(earlyClosedMessage)
        if (oldSeeing.has(capability.shareId)) {
          unsubscribe()
          throw new Error('This location link has ended.')
        }
        await client.sensor.describe({ sensorId: LOCATION_SENSOR_ID })
        const subscription = await client.sensor.subscribe({
          sensorId: LOCATION_SENSOR_ID,
        })
        activeSubscription.id = subscription.subscriptionId
        const pending =
          constellationProtocolV2.streams['sensor.observations'].observation.safeParse(
            pendingObservation,
          )
        if (pending.success && pending.data.subscriptionId === activeSubscription.id) {
          await receiveObservation(pending.data.observation)
        }
        const heartbeat = window.setInterval(() => {
          void client.share.heartbeat({ sessionId: session.sessionId }).catch(() => {
            recordSessionEvent('heartbeat-failed')
            const entry = followed.get(capability.shareId)
            if (entry) entry.connected = false
            publish({ message: 'The location connection was lost.' })
            void messagePort.close()
          })
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
        viewerClosers.set(capability.shareId, close)
        returnSenders.set(capability.shareId, (url) =>
          client.share.offerReturn({
            sessionId: session.sessionId,
            url,
            ownerPeerId: node.peerId.toString(),
          }),
        )
        const queuedReturn = pendingReturns.get(capability.shareId)
        if (queuedReturn) {
          try {
            await returnSenders.get(capability.shareId)!(queuedReturn)
            pendingReturns.delete(capability.shareId)
            await persist()
          } catch {
            publish({ message: 'Return link is queued until the original sharer reconnects.' })
          }
        }
        try {
          if (followed.get(capability.shareId)?.saved) await persist()
        } catch (error) {
          viewerClosers.delete(capability.shareId)
          returnSenders.delete(capability.shareId)
          if (existing) followed.set(capability.shareId, existing)
          else followed.delete(capability.shareId)
          await close()
          throw error
        }
        void messagePort.closed.then((result) => {
          window.clearInterval(heartbeat)
          unsubscribe()
          if (viewerClosers.get(capability.shareId) !== close) return
          viewerClosers.delete(capability.shareId)
          returnSenders.delete(capability.shareId)
          const entry = followed.get(capability.shareId)
          if (entry) {
            entry.connected = false
            if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
              endFollowing(capability.shareId, 'expired', entry.expiresAt)
              void persist().catch(() =>
                publish({ message: 'Ended location history could not be saved.' }),
              )
            }
          }
          if (result.reason !== 'local') {
            recordSessionEvent('transport-closed')
            publish({ message: 'The location connection closed. Reconnecting…' })
          }
          publish()
        })
        publish({
          message: received.has(capability.shareId) ? '' : 'Waiting for the first location…',
        })
      } catch (error) {
        if (oldSeeing.has(capability.shareId)) {
          publish()
        } else {
          if (previousFollow) followed.set(capability.shareId, previousFollow)
          else followed.delete(capability.shareId)
          if (previousObservation) received.set(capability.shareId, previousObservation)
        }
        await messagePort.close()
        throw error
      } finally {
        stopBufferingClose()
      }
    },
    stopFollowing: async (shareId) => {
      const close = viewerClosers.get(shareId)
      const entry = followed.get(shareId)
      const observation = received.get(shareId)
      const pendingReturn = pendingReturns.get(shareId)
      followed.delete(shareId)
      received.delete(shareId)
      pendingReturns.delete(shareId)
      try {
        if (entry?.saved) await persist()
      } catch (error) {
        if (entry) followed.set(shareId, entry)
        if (observation) received.set(shareId, observation)
        if (pendingReturn) pendingReturns.set(shareId, pendingReturn)
        throw error
      }
      viewerClosers.delete(shareId)
      returnSenders.delete(shareId)
      if (close) await close()
      publish()
    },
    saveFollowing: async (shareId, localName) => {
      const entry = followed.get(shareId)
      if (!entry) throw new Error('This location is no longer available.')
      if (!store || !privateStateAvailable) {
        throw new Error('Protected storage is unavailable; preview only.')
      }
      const previousName = entry.localName
      const wasSaved = entry.saved
      entry.localName = localName.trim().slice(0, 32) || generatedFollowName(shareId)
      entry.saved = true
      try {
        console.info('[constellation-persist] follow-save-queued')
        await persist(true)
      } catch (error) {
        entry.localName = previousName
        entry.saved = wasSaved
        throw error
      }
      publish()
    },
    setFollowName: (shareId, name) => {
      const entry = followed.get(shareId)
      if (!entry) return
      entry.localName = name.trim().slice(0, 32)
      if (entry.saved)
        void persist().catch(() => publish({ message: 'Nickname could not be saved.' }))
      publish()
    },
    setFollowColor: (shareId, color) => {
      if (!FOLLOW_COLORS.includes(color as (typeof FOLLOW_COLORS)[number])) return
      const entry = followed.get(shareId)
      if (!entry) return
      for (const candidate of followed.values()) {
        if (candidate.sourcePeerId === entry.sourcePeerId) candidate.color = color
      }
      if (entry.saved) void persist().catch(() => publish({ message: 'Color could not be saved.' }))
      publish()
    },
    setVisible: (nextVisible, acquireLocation = true) => {
      visible = nextVisible
      if (visible) {
        if (acquireLocation || shares.size > 0) locationSource.start()
      } else {
        for (const share of shares.values()) {
          if (share.publication === 'foreground') share.latest = undefined
        }
        if (![...shares.values()].some((share) => share.publication === 'background')) {
          locationSource.stop()
        }
      }
      publish()
    },
    stopShare: async (shareId) => {
      const share = shares.get(shareId)
      if (!share) return
      const oldRecord: OldShareSummary = {
        shareId,
        ...(share.name ? { name: share.name } : {}),
        reason: 'revoked',
        endedAt: Date.now(),
      }
      const previousOldRecord = oldSharing.get(shareId)
      const wasApproved = approvedReturnLinks.has(shareId)
      const removedOffers = [...returnOffers.entries()].filter(
        ([, offer]) => offer.shareId === shareId,
      )
      const previousEndNotifications = new Map(endedShares)
      pendingRevocations.add(shareId)
      rememberEndNotification(share, 'revoked', oldRecord.endedAt)
      const prunedEndIds = pruneEndNotifications()
      shares.delete(shareId)
      rememberLifecycleRecord(oldSharing, oldRecord)
      approvedReturnLinks.delete(shareId)
      removedOffers.forEach(([key]) => returnOffers.delete(key))
      try {
        await persist()
        pendingRevocations.delete(shareId)
      } catch (error) {
        pendingRevocations.delete(shareId)
        shares.set(shareId, share)
        endedShares.clear()
        previousEndNotifications.forEach((record, id) => endedShares.set(id, record))
        if (previousOldRecord) oldSharing.set(shareId, previousOldRecord)
        else oldSharing.delete(shareId)
        if (wasApproved) approvedReturnLinks.add(shareId)
        removedOffers.forEach(([key, offer]) => returnOffers.set(key, offer))
        throw error
      }
      for (const session of share.sessions) {
        if (session.sessionId) {
          session.send(
            constellationProtocolV2.streams['share.sessions'].closed.parse({
              type: 'closed',
              sessionId: session.sessionId,
              reason: 'revoked',
            }),
          )
        }
      }
      await Promise.all([...share.sessions].map((session) => session.closeAfterFlush()))
      await Promise.all(prunedEndIds.map(stopSourcePeer))
      if (!shares.size) locationSource.stop()
      publish()
    },
    stopEndNotifications: async () => {
      const previous = new Map(endedShares)
      endedShares.clear()
      try {
        await persist()
      } catch (error) {
        previous.forEach((record, id) => endedShares.set(id, record))
        throw error
      }
      await Promise.all([...previous.keys()].map(stopSourcePeer))
      publish()
    },
    stop: async () => {
      window.clearInterval(heartbeatSweep)
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
      unsubscribeLocationState()
      unsubscribeLocationObservation()
      locationSource.stop()
      await Promise.all([...viewerClosers.values()].map((close) => close()))
      for (const share of shares.values()) {
        await Promise.all([...share.sessions].map((session) => session.close()))
      }
      await Promise.all(
        [...new Set([...sourceStarts.keys(), ...sourceNodes.keys()])].map((shareId) =>
          stopSourcePeer(shareId),
        ),
      )
      if (handlerNode) {
        await handlerNode.unhandle(SHARE_STREAM_PROTOCOL)
        await handlerNode.stop()
      }
      shares.clear()
      received.clear()
      followed.clear()
      observers.clear()
    },
  }
  return runtime
}
