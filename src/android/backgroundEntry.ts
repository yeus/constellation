import type { SharingBehavior } from '../sharing/sharingBehavior.ts'
import type { PeerHistoryProtection } from '../sharing/peerHistory.ts'
import {
  executeBackgroundReturnCommand,
  type BackgroundReturnCommand,
} from './backgroundReturnCommand.ts'
import {
  hasStalledDelivery,
  shouldAttemptTransportRecovery,
  shouldSignalIdleAfterShareUpdate,
} from './backgroundRuntimePolicy.ts'
import { createBackgroundViewer, type BackgroundViewerSnapshot } from './backgroundViewer.ts'
import { backgroundRuntimeStatus } from './backgroundRuntimeStatus.ts'
import { createBrowserLocationSource, type BrowserPosition } from '../location/browser.ts'
import type { ShareDraft } from '../shareDraft.ts'
import {
  parsePrivateStateJson,
  type PrivateState,
  type PrivateStateStore,
} from '../sharing/privateStore.ts'
import { createSharingRuntime, type SharingRuntimeState } from '../sharing/sharingRuntime.ts'

interface NativeBridge {
  postMessage: (message: string) => void
}

declare global {
  interface Window {
    ConstellationNative?: NativeBridge
    __constellationBackgroundCommand?: (command: string) => void
  }
}

type CreateRequest = {
  readonly precision: ShareDraft['precision']
  readonly viewerCapacity: ShareDraft['viewerCapacity']
  readonly requireViewerApproval?: boolean
  readonly name: string
  readonly publication: ShareDraft['publication']
  readonly battery?: ShareDraft['battery']
  readonly network?: ShareDraft['network']
  readonly visible: boolean
  readonly expiresAt: number | null
  readonly shareBaseUrl: string
}

type ReplaceOwnerCommand = {
  readonly type: 'replace-background-owner'
  readonly requestId: string
  readonly shareId: string
  readonly sourcePeerId: string
  readonly ownerPeerId: string
  readonly ownerProof: string
  readonly mode: 'source' | 'recipient'
  readonly recipientPeerId?: string
}

type BackgroundCommand =
  | { readonly type: 'import-source-state'; readonly requestId: string; readonly state: string }
  | {
      readonly type: 'set-sharing-behavior'
      readonly requestId: string
      readonly behavior: SharingBehavior
    }
  | {
      readonly type: 'clear-old-peers'
      readonly requestId: string
      readonly protection: PeerHistoryProtection
    }
  | {
      readonly type: 'adopt-peer-name'
      readonly requestId: string
      readonly peerId: string
      readonly name: string
    }
  | {
      readonly type: 'device-comparison'
      readonly requestId: string
      readonly shareId: string
      readonly challenge: string
      readonly action: 'confirm' | 'cancel'
    }
  | {
      readonly type: 'set-peer-names'
      readonly requestId: string
      readonly peerId: string
      readonly associateNames: boolean
      readonly sharedName: string | null
    }
  | { readonly type: 'receiver-start'; readonly requestId: string; readonly generation: number }
  | { readonly type: 'receiver-stop'; readonly requestId: string; readonly generation: number }
  | { readonly type: 'create-share'; readonly requestId: string; readonly request: CreateRequest }
  | { readonly type: 'location'; readonly position: BrowserPosition }
  | { readonly type: 'location-refresh-result'; readonly position: BrowserPosition }
  | { readonly type: 'location-error'; readonly code: number }
  | { readonly type: 'stop-share'; readonly shareId: string }
  | { readonly type: 'stop-all' }
  | { readonly type: 'set-paused'; readonly requestId: string; readonly paused: boolean }
  | { readonly type: 'stop-foreground-only' }
  | {
      readonly type: 'network-state'
      readonly state: 'unmetered' | 'metered' | 'data-saver'
      readonly online?: boolean
    }
  | {
      readonly type: 'recover-background-sources'
      readonly online: boolean
      readonly stalled?: boolean
    }
  | { readonly type: 'set-visible'; readonly visible: boolean }
  | { readonly type: 'block-viewer'; readonly shareId: string; readonly fingerprint: string }
  | {
      readonly type: 'approve-viewer'
      readonly requestId: string
      readonly shareId: string
      readonly peerId: string
    }
  | ReplaceOwnerCommand
  | BackgroundReturnCommand
  | {
      readonly type: 'set-viewer-name'
      readonly shareId: string
      readonly fingerprint: string
      readonly name: string
    }
  | {
      readonly type: 'private-state-result'
      readonly requestId: string
      readonly state?: string | null
      readonly error?: string
    }

const post = (value: unknown): void =>
  window.ConstellationNative?.postMessage(JSON.stringify(value))

const durationFor = (expiresAt: number | null): ShareDraft['duration'] => {
  if (expiresAt === null) return 'until-revoked'
  return expiresAt - Date.now() > 60 * 60 * 1_000 ? '8h' : '1h'
}

const draftFor = (request: CreateRequest): ShareDraft => ({
  precision: request.precision,
  duration: durationFor(request.expiresAt),
  viewerCapacity: request.viewerCapacity,
  requireViewerApproval: request.requireViewerApproval !== false,
  untilRevokedAcknowledged: request.expiresAt === null,
  name: request.name,
  publication: request.publication,
  battery: request.battery ?? 'balanced',
  network: request.network ?? 'always',
})

interface StoreState {
  readonly pendingStoreRequests: Map<
    string,
    { resolve: (state: string | null | undefined) => void; reject: (error: Error) => void }
  >
  requestCounter: number
}

interface LocationObservers {
  positionObserver?: (position: BrowserPosition) => void
  refreshObserver?: (position: BrowserPosition) => void
  errorObserver?: (error: { code: number }) => void
}

interface BackgroundEntryState extends StoreState {
  readonly observers: LocationObservers
  readonly location: ReturnType<typeof createBrowserLocationSource>
  readonly runtime: ReturnType<typeof createSharingRuntime>
  viewer?: ReturnType<typeof createBackgroundViewer>
  viewerGeneration?: number
  latestViewer?: BackgroundViewerSnapshot
  latestState?: SharingRuntimeState
  previousShareCount: number
  lastRecoveryAt: number | null
  networkOnline: boolean
  commandQueue: Promise<void>
}

const createStoreState = (): StoreState => ({
  pendingStoreRequests: new Map(),
  requestCounter: 0,
})

const storeRequest = (
  state: StoreState,
  action: 'load' | 'save',
  privateState?: PrivateState,
  scope: 'source' | 'viewer' = 'source',
  generation?: number,
) =>
  new Promise<string | null | undefined>((resolve, reject) => {
    const requestId = `${Date.now()}-${++state.requestCounter}`
    state.pendingStoreRequests.set(requestId, { resolve, reject })
    post({
      type: 'private-state',
      scope,
      ...(generation !== undefined ? { generation } : {}),
      action,
      requestId,
      ...(privateState ? { state: JSON.stringify(privateState) } : {}),
    })
  })

const createPrivateStore = (
  state: StoreState,
  scope: 'source' | 'viewer' = 'source',
  generation?: number,
): PrivateStateStore => ({
  load: async () => {
    const encoded = await storeRequest(state, 'load', undefined, scope, generation)
    return encoded ? parsePrivateStateJson(encoded) : undefined
  },
  save: async (next) => {
    await storeRequest(state, 'save', next, scope, generation)
  },
})

const createBackgroundEntryState = (): BackgroundEntryState => {
  const observers: LocationObservers = {}
  const location = createBrowserLocationSource({
    sourceId: crypto.randomUUID(),
    geolocation: {
      watchPosition: (success, error) => {
        observers.positionObserver = success
        observers.errorObserver = error
        post({ type: 'location-watch-start' })
        return 1
      },
      clearWatch: () => post({ type: 'location-watch-stop' }),
      getCurrentPosition: (success) => {
        observers.refreshObserver = success
        post({ type: 'location-refresh' })
      },
    },
  })
  const store = createStoreState()
  const runtime = createSharingRuntime(location, undefined, createPrivateStore(store), 'external')
  runtime.setVisible(false, false)
  runtime.setNetworkState('unknown')
  return {
    ...store,
    observers,
    location,
    runtime,
    previousShareCount: 0,
    lastRecoveryAt: null,
    networkOnline: false,
    commandQueue: Promise.resolve(),
  }
}

const report = (state: BackgroundEntryState, next: SharingRuntimeState): void => {
  const shareCount = next.shares.length
  const workCount = shareCount + next.endNotifications.length
  const becameIdle = shouldSignalIdleAfterShareUpdate(state.previousShareCount, workCount)
  state.previousShareCount = workCount
  state.latestState = next
  post({
    type: 'status',
    status: backgroundRuntimeStatus(next, state.runtime.networkDiagnostics(), next.location),
  })
  if (becameIdle) post({ type: 'idle' })
}

const sendError = (state: BackgroundEntryState, error: unknown, fallback: string): void => {
  post({
    type: 'status',
    status: backgroundRuntimeStatus(
      state.latestState,
      state.runtime.networkDiagnostics(),
      state.location.getState(),
      error instanceof Error ? error.message : fallback,
    ),
  })
}

const resolveStoreResult = (
  state: StoreState,
  command: Extract<BackgroundCommand, { type: 'private-state-result' }>,
): void => {
  const pending = state.pendingStoreRequests.get(command.requestId)
  if (!pending) return
  state.pendingStoreRequests.delete(command.requestId)
  if (command.error) pending.reject(new Error(command.error))
  else pending.resolve(command.state)
}

const handleTransientCommand = (
  state: BackgroundEntryState,
  command: BackgroundCommand,
): boolean => {
  switch (command.type) {
    case 'private-state-result':
      resolveStoreResult(state, command)
      return true
    case 'location':
      state.observers.positionObserver?.(command.position)
      return true
    case 'location-refresh-result':
      state.observers.refreshObserver?.(command.position)
      state.observers.refreshObserver = undefined
      return true
    case 'location-error':
      state.observers.errorObserver?.({ code: command.code })
      return true
    default:
      return false
  }
}

const isTransientCommandType = (type: BackgroundCommand['type']): boolean =>
  type === 'private-state-result' ||
  type === 'location' ||
  type === 'location-refresh-result' ||
  type === 'location-error'

const isShareCommandType = (type: BackgroundCommand['type']): boolean =>
  type === 'create-share' ||
  type === 'stop-share' ||
  type === 'stop-all' ||
  type === 'stop-foreground-only' ||
  type === 'set-visible' ||
  type === 'set-paused' ||
  type === 'network-state' ||
  type === 'recover-background-sources'

const isViewerCommandType = (type: BackgroundCommand['type']): boolean =>
  type === 'block-viewer' ||
  type === 'device-comparison' ||
  type === 'approve-viewer' ||
  type === 'set-viewer-name'

const isReturnCommandType = (command: BackgroundCommand): command is BackgroundReturnCommand =>
  command.type === 'approve-return-link' ||
  command.type === 'dismiss-return-offer' ||
  command.type === 'dismiss-stopped-viewer'

const runCompletion = async (
  requestId: string,
  errorMessage: string,
  action: () => Promise<unknown>,
): Promise<void> => {
  try {
    await action()
    post({ type: 'command-complete', requestId })
  } catch {
    post({ type: 'command-complete', requestId, error: errorMessage })
  }
}

const createShareCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'create-share' }>,
): Promise<void> => {
  try {
    state.runtime.setVisible(command.request.visible, command.request.visible)
    await state.runtime.createShare(
      draftFor(command.request),
      command.request.expiresAt,
      command.request.shareBaseUrl,
    )
  } catch (error) {
    sendError(state, error, 'P2P sharing failed.')
  } finally {
    post({ type: 'create-complete', requestId: command.requestId })
  }
}

const stopShareCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'stop-share' }>,
): Promise<void> => {
  try {
    await state.runtime.stopShare(command.shareId)
  } catch (error) {
    sendError(state, error, 'Could not revoke this location link.')
  }
}

const stopAllCommand = async (state: BackgroundEntryState): Promise<void> => {
  try {
    const shares = state.latestState?.shares ?? []
    for (const { shareId } of shares) await state.runtime.stopShare(shareId)
    await state.runtime.stopEndNotifications()
  } catch (error) {
    sendError(state, error, 'Could not stop all location links.')
  }
  if (!state.latestState?.shares.length && !state.latestState?.endNotifications.length) {
    post({ type: 'idle' })
  }
}

const pauseForegroundOnly = async (state: BackgroundEntryState): Promise<void> => {
  if (
    state.viewer !== undefined ||
    state.latestState?.shares.some((share) => share.publication === 'background') ||
    state.latestState?.endNotifications.some((share) => share.publication === 'background')
  ) {
    return
  }
  await state.runtime.stop()
  post({ type: 'paused' })
}

const runShareCommand = async (
  state: BackgroundEntryState,
  command: BackgroundCommand,
): Promise<void> => {
  switch (command.type) {
    case 'create-share':
      return createShareCommand(state, command)
    case 'stop-share':
      return stopShareCommand(state, command)
    case 'stop-all':
      return stopAllCommand(state)
    case 'stop-foreground-only':
      state.runtime.setVisible(false, false)
      return pauseForegroundOnly(state)
    case 'set-visible':
      state.runtime.setVisible(command.visible, command.visible)
      if (!command.visible) await pauseForegroundOnly(state)
      return
    case 'set-paused':
      return runCompletion(command.requestId, 'Could not save the sharing pause. Try again.', () =>
        state.runtime.setPaused(command.paused),
      )
    case 'network-state':
      state.networkOnline = command.online === true
      state.runtime.setNetworkState(command.state === 'unmetered' ? undefined : command.state)
      return
    case 'recover-background-sources': {
      const now = Date.now()
      if (
        !shouldAttemptTransportRecovery({
          online: command.online,
          backgroundSources:
            state.latestState?.shares.filter((share) => share.publication === 'background')
              .length ?? 0,
          now,
          lastRecoveryAt: state.lastRecoveryAt,
          stalled: command.stalled,
        })
      )
        return
      state.lastRecoveryAt = now
      await state.runtime.recoverBackgroundSources()
      return
    }
  }
}

const blockViewerCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'block-viewer' }>,
): Promise<void> => {
  try {
    await state.runtime.blockViewer(command.shareId, command.fingerprint)
  } catch (error) {
    sendError(state, error, 'Could not block this device.')
  }
}

const ownerHandoffCommand = async (
  state: BackgroundEntryState,
  command: ReplaceOwnerCommand,
): Promise<void> => {
  await runCompletion(
    command.requestId,
    'Could not authenticate the foreground location owner.',
    () =>
      state.runtime.replaceBackgroundShareOwner(
        command.shareId,
        command.sourcePeerId,
        command.ownerPeerId,
        command.ownerProof,
        command.mode === 'recipient' && command.recipientPeerId
          ? { mode: 'recipient', recipientPeerId: command.recipientPeerId }
          : { mode: 'source' },
      ),
  )
}

const deviceComparisonCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'device-comparison' }>,
): Promise<void> => {
  await runCompletion(
    command.requestId,
    'Device comparison expired, cancelled or could not be saved.',
    () =>
      command.action === 'confirm'
        ? state.runtime.confirmDeviceComparison(command.shareId, command.challenge)
        : state.runtime.cancelDeviceComparison(command.shareId, command.challenge),
  )
}

const approveViewerCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'approve-viewer' }>,
): Promise<void> => {
  await runCompletion(command.requestId, 'Could not approve this device.', () =>
    state.runtime.approveViewer(command.shareId, command.peerId),
  )
}

const setViewerLabelCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'set-viewer-name' }>,
): Promise<void> => {
  try {
    await state.runtime.setViewerLabel(command.shareId, command.fingerprint, command.name)
  } catch (error) {
    sendError(state, error, 'Could not save this device name.')
  }
}

const runViewerCommand = async (
  state: BackgroundEntryState,
  command: BackgroundCommand,
): Promise<void> => {
  switch (command.type) {
    case 'block-viewer':
      return blockViewerCommand(state, command)
    case 'device-comparison':
      return deviceComparisonCommand(state, command)
    case 'approve-viewer':
      return approveViewerCommand(state, command)
    case 'set-viewer-name':
      return setViewerLabelCommand(state, command)
  }
}

const importSourceStateCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'import-source-state' }>,
): Promise<void> => {
  await runCompletion(command.requestId, 'Could not import protected source links.', async () => {
    await state.runtime.importSourceShares(parsePrivateStateJson(command.state))
    await state.runtime.initialize()
  })
}

const sharingBehaviorCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'set-sharing-behavior' }>,
): Promise<void> => {
  await runCompletion(command.requestId, 'Could not save sharing behavior.', () =>
    state.runtime.setSharingBehavior(command.behavior),
  )
}

const clearOldPeersCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'clear-old-peers' }>,
): Promise<void> => {
  await runCompletion(command.requestId, 'Could not clear old peers.', () =>
    state.runtime.clearOldPeers(command.protection),
  )
}

const adoptPeerNameCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'adopt-peer-name' }>,
): Promise<void> => {
  await runCompletion(
    command.requestId,
    'Name changed or could not be saved. Review it and retry.',
    () => state.runtime.adoptPeerName(command.peerId, command.name),
  )
}

const setPeerNamesCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'set-peer-names' }>,
): Promise<void> => {
  await runCompletion(command.requestId, 'Could not save peer name preferences.', () =>
    state.runtime.setPeerNamePreferences(
      command.peerId,
      command.associateNames,
      command.sharedName,
    ),
  )
}

const runReceiverCommand = async (
  state: BackgroundEntryState,
  command: Extract<BackgroundCommand, { type: 'receiver-start' | 'receiver-stop' }>,
): Promise<void> =>
  runCompletion(
    command.requestId,
    'Could not transfer background-following ownership.',
    async () => {
      if (!Number.isSafeInteger(command.generation) || command.generation < 1) {
        throw new Error('Invalid owner generation.')
      }
      if (command.type === 'receiver-stop') {
        if (!state.viewer) return
        if (state.viewerGeneration !== command.generation) {
          throw new Error('Background viewer generation mismatch.')
        }
        await state.viewer.stop()
        state.viewer = undefined
        state.viewerGeneration = undefined
        state.latestViewer = undefined
        post({ type: 'receiver-status', generation: command.generation, stopped: true })
        return
      }
      if (state.viewer) {
        if (state.viewerGeneration !== command.generation) {
          throw new Error('A different receiver already owns this device.')
        }
        return
      }
      const viewer = createBackgroundViewer({
        generation: command.generation,
        store: createPrivateStore(state, 'viewer', command.generation),
        onState: (status) => {
          state.latestViewer = status
          post({ type: 'receiver-status', status })
        },
      })
      try {
        await viewer.start()
        state.viewer = viewer
        state.viewerGeneration = command.generation
      } catch (error) {
        await viewer.stop().catch(() => undefined)
        throw error
      }
    },
  )

const runCommand = async (
  state: BackgroundEntryState,
  command: BackgroundCommand,
): Promise<void> => {
  if (handleTransientCommand(state, command)) return
  if (command.type === 'receiver-start' || command.type === 'receiver-stop') {
    return runReceiverCommand(state, command)
  }
  if (isShareCommandType(command.type)) return runShareCommand(state, command)
  if (isViewerCommandType(command.type)) return runViewerCommand(state, command)
  if (command.type === 'replace-background-owner') return ownerHandoffCommand(state, command)
  if (command.type === 'import-source-state') return importSourceStateCommand(state, command)
  if (command.type === 'set-sharing-behavior') return sharingBehaviorCommand(state, command)
  if (command.type === 'clear-old-peers') return clearOldPeersCommand(state, command)
  if (command.type === 'adopt-peer-name') return adoptPeerNameCommand(state, command)
  if (command.type === 'set-peer-names') return setPeerNamesCommand(state, command)
  if (isReturnCommandType(command)) {
    await executeBackgroundReturnCommand(state.runtime, command, post)
  }
}

const enqueueCommand = (state: BackgroundEntryState, encoded: string): void => {
  const command = JSON.parse(encoded) as BackgroundCommand
  if (isTransientCommandType(command.type)) {
    void runCommand(state, command)
    return
  }
  state.commandQueue = state.commandQueue
    .then(() => runCommand(state, command))
    .catch((error) => {
      sendError(state, error, 'The background sharing command failed.')
    })
}

const start = (): void => {
  const state = createBackgroundEntryState()
  window.__constellationBackgroundCommand = (encoded) => enqueueCommand(state, encoded)
  state.runtime.subscribe((next) => report(state, next))
  window.setInterval(() => {
    const now = Date.now()
    if (!state.networkOnline || !hasStalledDelivery(state.latestState?.shares ?? [], now)) return
    enqueueCommand(
      state,
      JSON.stringify({ type: 'recover-background-sources', online: true, stalled: true }),
    )
  }, 60_000)
  void state.runtime
    .initialize()
    .catch((error) => sendError(state, error, 'Could not restore protected sharing state.'))
    .finally(() => post({ type: 'ready' }))
}

start()
