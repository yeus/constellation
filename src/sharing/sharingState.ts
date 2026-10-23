import type { MapCamera } from '../map/mapCamera.ts'
import type { PrivateKey } from '@libp2p/interface'
import type { BrowserLibp2pNode } from '@taskyon/p2p-core/browser'
import type { BrowserLocationSource } from '../location/browser.ts'
import type { LocationObservationV1 } from '../location/locationObservation.ts'
import type { DeviceComparison, ComparisonBudget } from './deviceComparison.ts'
import type { PeerNamePreference } from './peerNames.ts'
import type { PendingStopNotice, PrivateStateStore, StoppedViewerRecord } from './privateStore.ts'
import type { NetworkRestriction } from './sharePolicy.ts'
import type {
  EndedSourceShare,
  FollowEntry,
  OldShareSummary,
  PendingViewerApproval,
  ReturnOffer,
  SessionEvent,
  SharingRuntimeState,
  SourceShare,
} from './sharingContracts.ts'
import type { SharingBehavior } from './sharingBehavior.ts'

const createShareStores = () => {
  const shares = new Map<string, SourceShare>()
  const endedShares = new Map<string, EndedSourceShare>()
  const pendingRevocations = new Set<string>()
  const reconnecting = new Set<string>()
  const sourceNodes = new Map<string, BrowserLibp2pNode>()
  const sourceStarts = new Map<string, Promise<{ node: BrowserLibp2pNode; addresses: string[] }>>()
  return { shares, endedShares, pendingRevocations, reconnecting, sourceNodes, sourceStarts }
}

const createRelationStores = () => {
  const deviceComparisons = new Map<string, DeviceComparison>()
  const comparisonBudgets: ComparisonBudget[] = []
  const comparisonRuns = new Map<string, { cancelled: boolean; close?: () => Promise<void> }>()
  const observers = new Set<(state: SharingRuntimeState) => void>()
  const received = new Map<string, LocationObservationV1>()
  const followed = new Map<string, FollowEntry>()
  const viewerLabels = new Map<string, string>()
  const peerNamePreferences = new Map<string, PeerNamePreference>()
  const nameListeners = new Map<string, Set<(name: string | null) => void>>()
  const nameSenders = new Map<
    string,
    { send: (name: string | null) => Promise<void>; close: () => Promise<void> }
  >()
  const viewerClosers = new Map<
    string,
    (explicit?: boolean, eventId?: string) => Promise<boolean>
  >()
  const returnSenders = new Map<string, (url: string) => Promise<void>>()
  const returnOffers = new Map<string, ReturnOffer>()
  const approvedReturnLinks = new Set<string>()
  const pendingViewerApprovals = new Map<string, PendingViewerApproval>()
  const pendingReturns = new Map<string, string>()
  const oldSharing = new Map<string, OldShareSummary>()
  const oldSeeing = new Map<string, OldShareSummary>()
  const stoppedViewers = new Map<string, StoppedViewerRecord>()
  const pendingStopNotices = new Map<string, PendingStopNotice>()
  return {
    deviceComparisons,
    comparisonBudgets,
    comparisonRuns,
    observers,
    received,
    followed,
    viewerLabels,
    peerNamePreferences,
    nameListeners,
    nameSenders,
    viewerClosers,
    returnSenders,
    returnOffers,
    approvedReturnLinks,
    pendingViewerApprovals,
    pendingReturns,
    oldSharing,
    oldSeeing,
    stoppedViewers,
    pendingStopNotices,
  }
}

const createRuntimeFlags = () => {
  const retryingStopNotices = false
  const stopRetryAt = 0
  const runtimeClosed = false
  let noticeTimer: number | undefined
  let traceSaveTimer: number | undefined
  const lastTraceSavedAt = 0
  let mapCameraSaveTimer: number | undefined
  let mapCamera: MapCamera | undefined
  let peer: Promise<{ node: BrowserLibp2pNode; addresses: string[] }> | undefined
  let handlerNode: BrowserLibp2pNode | undefined
  const visible = true
  const paused = false
  let privateKey: PrivateKey | undefined
  let preparation: Promise<void> | undefined
  const persistence = Promise.resolve()
  const privateStateAvailable = true
  const sessionEvents: readonly SessionEvent[] = []
  const sessionEventSequence = 0
  let sharingBehavior: SharingBehavior | undefined
  let pendingSharingBehavior: SharingBehavior | undefined
  let networkRestriction: NetworkRestriction | undefined
  return {
    retryingStopNotices,
    stopRetryAt,
    runtimeClosed,
    noticeTimer,
    peer,
    traceSaveTimer,
    lastTraceSavedAt,
    mapCameraSaveTimer,
    mapCamera,
    handlerNode,
    visible,
    paused,
    privateKey,
    preparation,
    persistence,
    privateStateAvailable,
    sessionEvents,
    sessionEventSequence,
    sharingBehavior,
    pendingSharingBehavior,
    networkRestriction,
  }
}

const createInitialState = (
  locationSource: BrowserLocationSource,
  store: PrivateStateStore | undefined,
): SharingRuntimeState => ({
  peerStatus: 'offline',
  privateStateReady: !store,
  paused: false,
  location: locationSource.getState(),
  shares: [],
  received: [],
  following: [],
  returnOffers: [],
  approvedReturnLinks: [],
  pendingViewerApprovals: [],
  oldSharing: [],
  oldSeeing: [],
  stoppedViewers: [],
  endNotifications: [],
  message: '',
  canSave: Boolean(store),
})

export const createSharingState = (
  locationSource: BrowserLocationSource,
  store: PrivateStateStore | undefined,
) => ({
  ...createShareStores(),
  ...createRelationStores(),
  ...createRuntimeFlags(),
  state: createInitialState(locationSource, store),
})

export type SharingState = ReturnType<typeof createSharingState>
