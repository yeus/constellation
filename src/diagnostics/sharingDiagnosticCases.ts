import { createShareDraft } from '../shareDraft.ts'
import { parseShareInvitation } from '../sharing/shareLink.ts'
import type { DiagnosticSession } from './diagnosticSession.ts'
import type {
  AndroidBackgroundStatus,
  createAndroidBackgroundSharing,
} from '../android/backgroundSharing.ts'

export interface DiagnosticPairing {
  role: 'none' | 'host' | 'join'
  url: string
}
export interface SharingDiagnosticDependencies {
  shareBaseUrl: string
  createSession: () => DiagnosticSession
  capabilities: () => { secureContext: boolean; crypto: boolean; webRTC: boolean }
  pairing: () => DiagnosticPairing
  invitation: (url: string) => void
  stage: (message: string) => void
  native?: NonNullable<ReturnType<typeof createAndroidBackgroundSharing>>
  nativeConsent?: () => boolean
  visibility?: {
    isHidden: () => boolean
    subscribe: (listener: (hidden: boolean) => void) => () => void
  }
}

const draft = (viewerCapacity: 1 | 10 = 10) => ({
  ...createShareDraft(),
  name: 'Sharing diagnostics',
  precision: 'exact' as const,
  viewerCapacity,
})
const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const waitForUpdates = async (session: DiagnosticSession, signal: AbortSignal) => {
  const first = await session.wait((state) => state.received.length > 0, signal)
  const entry = first.received[0]!
  await session.wait(
    (state) =>
      (state.received.find(({ shareId }) => shareId === entry.shareId)?.observation.sequence ?? 0) >
      entry.observation.sequence + 1,
    signal,
  )
}

const waitForTerminal = async (
  session: DiagnosticSession,
  shareId: string,
  reason: 'revoked' | 'expired',
  signal: AbortSignal,
) => {
  await session.wait(
    (state) =>
      state.oldSeeing.some((entry) => entry.shareId === shareId && entry.reason === reason),
    signal,
  )
  check(
    !session.state().received.some((entry) => entry.shareId === shareId),
    'Terminal location remained visible.',
  )
}

const hostLifecycle = async (
  session: DiagnosticSession,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const share = await session.runtime.createShare(draft(), Date.now() + 600_000)
  dependencies.invitation(share.url)
  dependencies.stage('Waiting for the other device to join and offer its diagnostic return link.')
  const state = await session.wait(
    (next) => next.returnOffers.some((offer) => offer.shareId === share.shareId),
    signal,
  )
  const offer = state.returnOffers.find((entry) => entry.shareId === share.shareId)!
  const returnId = parseShareInvitation(offer.url).shareId
  await session.runtime.approveReturnLink(share.shareId)
  await waitForUpdates(session, signal)
  check(
    session
      .state()
      .shares.some((entry) => entry.shareId === share.shareId && entry.viewerCount === 1),
    'Expected one connected diagnostic viewer.',
  )
  dependencies.stage('Two-way updates verified. Checking revocation in both directions.')
  await session.runtime.stopShare(share.shareId)
  await waitForTerminal(session, returnId, 'revoked', signal)
}

const joinLifecycle = async (
  session: DiagnosticSession,
  url: string,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const id = parseShareInvitation(url).shareId
  await session.runtime.acceptShare(url, { saved: false })
  dependencies.stage('Waiting for synthetic location updates from the paired device.')
  await waitForUpdates(session, signal)
  dependencies.stage('Synthetic updates received. Creating a private diagnostic return link.')
  const returned = await session.runtime.createShare(draft(1), Date.now() + 600_000)
  dependencies.stage('Return link ready. Sending it over the original location session.')
  await session.runtime.offerReturnShare(id, returned.url)
  await session.wait(
    (state) =>
      state.shares.some((share) => share.shareId === returned.shareId && share.viewerCount === 1),
    signal,
  )
  await waitForTerminal(session, id, 'revoked', signal)
  await session.runtime.stopShare(returned.shareId)
}

const runExpiryHost = async (
  session: DiagnosticSession,
  shareId: string,
  signal: AbortSignal,
): Promise<void> => {
  await session.wait(
    (state) =>
      state.oldSharing.some(
        (entry) => entry.shareId === shareId && entry.reason === 'expired',
      ),
    signal,
  )
}

const runReconnectHost = async (
  session: DiagnosticSession,
  shareId: string,
  signal: AbortSignal,
): Promise<void> => {
  await session.wait(
    (state) => state.shares.some((entry) => entry.shareId === shareId && entry.viewerCount === 0),
    signal,
  )
  await session.wait(
    (state) => state.shares.some((entry) => entry.shareId === shareId && entry.viewerCount > 0),
    signal,
  )
  const resumed = session.state().location
  const sequence = 'observation' in resumed ? resumed.observation.sequence : 0
  await session.wait(
    (state) =>
      'observation' in state.location && state.location.observation.sequence > sequence + 4,
    signal,
  )
  await session.runtime.stopShare(shareId)
}

const runHostTimedDiagnostic = async (
  kind: 'expiry' | 'reconnect',
  session: DiagnosticSession,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
): Promise<void> => {
  const share = await session.runtime.createShare(
    draft(),
    Date.now() + (kind === 'expiry' ? 60_000 : 600_000),
  )
  dependencies.invitation(share.url)
  dependencies.stage(
    kind === 'expiry'
      ? 'Ask the other device to run Link expiry with this new link.'
      : 'Ask the other device to run Network reconnect with this new link and temporarily disconnect its network.',
  )
  await session.wait(
    (state) =>
      state.shares.some((entry) => entry.shareId === share.shareId && entry.viewerCount > 0),
    signal,
  )
  if (kind === 'expiry') await runExpiryHost(session, share.shareId, signal)
  else await runReconnectHost(session, share.shareId, signal)
}

const runJoinTimedDiagnostic = async (
  kind: 'expiry' | 'reconnect',
  session: DiagnosticSession,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
): Promise<void> => {
  const id = parseShareInvitation(dependencies.pairing().url).shareId
  await session.runtime.acceptShare(dependencies.pairing().url, { saved: true })
  await waitForUpdates(session, signal)
  if (kind === 'reconnect') {
    dependencies.stage(
      'Disconnect this device’s network until it shows disconnected; restore it to check reconnection.',
    )
    await session.wait(
      (state) => state.following.some((entry) => entry.shareId === id && !entry.connected),
      signal,
    )
    await session.wait(
      (state) => state.following.some((entry) => entry.shareId === id && entry.connected),
      signal,
    )
    await waitForUpdates(session, signal)
  }
  await waitForTerminal(session, id, kind === 'expiry' ? 'expired' : 'revoked', signal)
}

export const runPairedDiagnostic = async (
  kind: 'lifecycle' | 'expiry' | 'reconnect',
  session: DiagnosticSession,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const pairing = dependencies.pairing()
  if (kind === 'lifecycle') {
    if (pairing.role === 'host') await hostLifecycle(session, dependencies, signal)
    else await joinLifecycle(session, pairing.url, dependencies, signal)
  } else if (pairing.role === 'host') {
    await runHostTimedDiagnostic(kind, session, dependencies, signal)
  } else {
    await runJoinTimedDiagnostic(kind, session, dependencies, signal)
  }
  return { transports: session.transports() }
}

export const waitForDiagnosticValue = async <T>(
  read: () => Promise<T>,
  predicate: (status: T) => boolean,
  signal: AbortSignal,
) => {
  while (!signal.aborted) {
    const status = await read()
    if (signal.aborted) throw new Error('Diagnostic cancelled.')
    if (predicate(status)) return status
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(new Error('Diagnostic cancelled.'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, 1_000)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  throw new Error('Diagnostic cancelled.')
}

interface NativeDiagnosticState {
  readonly native: NonNullable<SharingDiagnosticDependencies['native']>
  readonly existingIds: Set<string>
  readonly ownedIds: Set<string>
  readonly diagnosticName: string
  readonly visibility: NonNullable<SharingDiagnosticDependencies['visibility']>
  wasHidden: boolean
  hiddenAt: number
  resumedAt: number
  unsubscribeVisibility: () => void
}

const prepareNativeDiagnostic = async (
  dependencies: SharingDiagnosticDependencies,
): Promise<NativeDiagnosticState> => {
  const native = dependencies.native!
  const visibility = dependencies.visibility!
  const before = await native.status()
  const state: NativeDiagnosticState = {
    native,
    existingIds: new Set(before.shares.map((entry) => entry.shareId)),
    ownedIds: new Set(),
    diagnosticName: `Diagnostics ${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    visibility,
    wasHidden: false,
    hiddenAt: 0,
    resumedAt: 0,
    unsubscribeVisibility: () => undefined,
  }
  state.unsubscribeVisibility = visibility.subscribe((hidden) => {
    if (hidden) {
      state.wasHidden = true
      state.hiddenAt = Date.now()
    } else if (state.wasHidden) {
      state.resumedAt = Date.now()
    }
  })
  return state
}

const rememberOwnedShares = (
  state: NativeDiagnosticState,
  status: AndroidBackgroundStatus,
) => {
  const owned = status.shares.filter(
    (entry) => !state.existingIds.has(entry.shareId) && entry.name === state.diagnosticName,
  )
  owned.forEach((entry) => state.ownedIds.add(entry.shareId))
  return owned
}

const startNativeShare = async (
  state: NativeDiagnosticState,
  dependencies: SharingDiagnosticDependencies,
): Promise<string> => {
  const started = await state.native.start(
    { ...draft(), name: state.diagnosticName, duration: '1h', publication: 'background' },
    dependencies.shareBaseUrl,
    !state.visibility.isHidden(),
  )
  const owned = rememberOwnedShares(state, started)
  check(owned.length === 1, 'Expected exactly one new background link.')
  const ownedId = owned[0]!.shareId
  dependencies.invitation(owned[0]!.url)
  dependencies.stage(
    'This temporary share uses your real location. On the other device, choose Join and run Android background check. Then lock and unlock this phone.',
  )
  return ownedId
}

const waitForNativeBackgroundFix = async (
  state: NativeDiagnosticState,
  ownedId: string,
  signal: AbortSignal,
): Promise<boolean> => {
  const connected = await waitForDiagnosticValue(
    state.native.status,
    (status) =>
      status.shares.some((entry) => entry.shareId === ownedId && entry.viewerCount > 0) &&
      'observation' in status.location,
    signal,
  )
  const initialSequence =
    'observation' in connected.location ? connected.location.observation.sequence : 0
  const resumed = await waitForDiagnosticValue(
    state.native.status,
    (status) =>
      state.wasHidden &&
      !state.visibility.isHidden() &&
      status.shares.some((entry) => entry.shareId === ownedId && entry.viewerCount > 0),
    signal,
  )
  return (
    'observation' in resumed.location &&
    resumed.location.observation.sequence > initialSequence &&
    resumed.location.observation.capturedAt >= state.hiddenAt &&
    resumed.location.observation.capturedAt <= state.resumedAt
  )
}

const runNativeDiagnosticSession = async (
  state: NativeDiagnosticState,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const ownedId = await startNativeShare(state, dependencies)
  const observedHiddenFix = await waitForNativeBackgroundFix(state, ownedId, signal)
  await state.native.stop(ownedId)
  state.ownedIds.delete(ownedId)
  return observedHiddenFix
    ? { code: 'background-lock-resume-verified' }
    : { skipped: true as const, reason: 'background-fix-evidence-unavailable' }
}

const cleanupNativeShares = async (
  state: NativeDiagnosticState,
): Promise<PromiseRejectedResult | undefined> => {
  // A start can create a link even when its returned status cannot be parsed.
  const reconciled = await Promise.allSettled([
    state.native.status().then((status) => rememberOwnedShares(state, status)),
  ])
  const stopped = await Promise.allSettled(
    [...state.ownedIds].map((id) => state.native.stop(id)),
  )
  return [...reconciled, ...stopped].find((entry) => entry.status === 'rejected')
}

export const runNativeDiagnostic = async (
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const state = await prepareNativeDiagnostic(dependencies)
  let cleanupFailure: PromiseRejectedResult | undefined
  try {
    return await runNativeDiagnosticSession(state, dependencies, signal)
  } finally {
    state.unsubscribeVisibility()
    cleanupFailure = await cleanupNativeShares(state)
    if (cleanupFailure) throw cleanupFailure.reason
  }
}

export const joinNativeDiagnostic = async (
  session: DiagnosticSession,
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const url = dependencies.pairing().url
  const id = parseShareInvitation(url).shareId
  await session.runtime.acceptShare(url, { saved: false })
  dependencies.stage(
    'Waiting for updates while the Android participant locks and unlocks their phone.',
  )
  await waitForUpdates(session, signal)
  await waitForTerminal(session, id, 'revoked', signal)
  return { code: 'background-delivery-verified' }
}
