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
    if (kind === 'expiry')
      await session.wait(
        (state) =>
          state.oldSharing.some(
            (entry) => entry.shareId === share.shareId && entry.reason === 'expired',
          ),
        signal,
      )
    else {
      await session.wait(
        (state) =>
          state.shares.some((entry) => entry.shareId === share.shareId && entry.viewerCount === 0),
        signal,
      )
      await session.wait(
        (state) =>
          state.shares.some((entry) => entry.shareId === share.shareId && entry.viewerCount > 0),
        signal,
      )
      const resumed = session.state().location
      const sequence = 'observation' in resumed ? resumed.observation.sequence : 0
      await session.wait(
        (state) =>
          'observation' in state.location && state.location.observation.sequence > sequence + 4,
        signal,
      )
      await session.runtime.stopShare(share.shareId)
    }
  } else {
    const id = parseShareInvitation(pairing.url).shareId
    await session.runtime.acceptShare(pairing.url, { saved: true })
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

export const runNativeDiagnostic = async (
  dependencies: SharingDiagnosticDependencies,
  signal: AbortSignal,
) => {
  const native = dependencies.native!
  const before = await native.status()
  const existingIds = new Set(before.shares.map((entry) => entry.shareId))
  const ownedIds = new Set<string>()
  const diagnosticName = `Diagnostics ${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  const rememberOwned = (status: AndroidBackgroundStatus) => {
    const owned = status.shares.filter(
      (entry) => !existingIds.has(entry.shareId) && entry.name === diagnosticName,
    )
    owned.forEach((entry) => ownedIds.add(entry.shareId))
    return owned
  }
  let ownedId: string | undefined
  let result: { code: string } | { skipped: true; reason: string }
  let cleanupFailure: PromiseRejectedResult | undefined
  let wasHidden = false
  const visibility = dependencies.visibility!
  let hiddenAt = 0
  let resumedAt = 0
  const unsubscribeVisibility = visibility.subscribe((hidden) => {
    if (hidden) {
      wasHidden = true
      hiddenAt = Date.now()
    } else if (wasHidden) resumedAt = Date.now()
  })
  try {
    const started = await native.start(
      { ...draft(), name: diagnosticName, duration: '1h', publication: 'background' },
      dependencies.shareBaseUrl,
      !visibility.isHidden(),
    )
    const owned = rememberOwned(started)
    check(owned.length === 1, 'Expected exactly one new background link.')
    ownedId = owned[0]!.shareId
    dependencies.invitation(owned[0]!.url)
    dependencies.stage(
      'This temporary share uses your real location. On the other device, choose Join and run Android background check. Then lock and unlock this phone.',
    )
    const connected = await waitForDiagnosticValue(
      native.status,
      (status) =>
        status.shares.some((entry) => entry.shareId === ownedId && entry.viewerCount > 0) &&
        'observation' in status.location,
      signal,
    )
    const initialSequence =
      'observation' in connected.location ? connected.location.observation.sequence : 0
    const resumed = await waitForDiagnosticValue(
      native.status,
      (status) =>
        wasHidden &&
        !visibility.isHidden() &&
        status.shares.some((entry) => entry.shareId === ownedId && entry.viewerCount > 0),
      signal,
    )
    const observedHiddenFix =
      'observation' in resumed.location &&
      resumed.location.observation.sequence > initialSequence &&
      resumed.location.observation.capturedAt >= hiddenAt &&
      resumed.location.observation.capturedAt <= resumedAt
    await native.stop(ownedId)
    ownedIds.delete(ownedId)
    ownedId = undefined
    result = observedHiddenFix
      ? { code: 'background-lock-resume-verified' }
      : { skipped: true, reason: 'background-fix-evidence-unavailable' }
  } finally {
    unsubscribeVisibility()
    // A start can create a link even when its returned status cannot be parsed.
    const reconciled = await Promise.allSettled([native.status().then(rememberOwned)])
    const stopped = await Promise.allSettled([...ownedIds].map((id) => native.stop(id)))
    cleanupFailure = [...reconciled, ...stopped].find((result) => result.status === 'rejected')
  }
  if (cleanupFailure) throw cleanupFailure.reason
  return result
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
