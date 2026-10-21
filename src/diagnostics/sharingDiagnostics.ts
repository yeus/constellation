import {
  getDiagnosticsSkipReason,
  runDiagnosticsTests,
  type DiagnosticsRunResult,
  type DiagnosticsTestContext,
  type TaskyonTestFn,
} from '@taskyon/diagnostics'
import { parseShareInvitation } from '../sharing/shareLink.ts'
import { createShareDraft } from '../shareDraft.ts'
import { TRANSPORT_KINDS } from '../sharing/transport.ts'
import { createLocationFeatureCollection } from '../location/mapModel.ts'
import {
  runPairedDiagnostic,
  runNativeDiagnostic,
  joinNativeDiagnostic,
  waitForDiagnosticValue,
  type SharingDiagnosticDependencies,
} from './sharingDiagnosticCases.ts'

export interface SharingDiagnosticResult {
  id: string
  status: 'passed' | 'failed' | 'skipped' | 'cancelled'
  elapsedMs: number
  code?: string
  transports?: string[]
  phase?: string
}

export const diagnosticResult = (
  result: DiagnosticsRunResult,
  elapsedMs: number,
  cancelled: boolean,
): SharingDiagnosticResult => {
  const skip = getDiagnosticsSkipReason(result.details)
  const skipCode = [
    'partner-required',
    'android-required',
    'real-location-consent-required',
    'background-fix-evidence-unavailable',
  ].includes(skip ?? '')
    ? skip
    : skip === 'Requires explicit permission for long-running diagnostics.'
      ? 'guided-check-not-selected'
      : 'prerequisite-unavailable'
  const details = result.details
  const transports =
    details &&
    typeof details === 'object' &&
    'transports' in details &&
    Array.isArray(details.transports)
      ? details.transports.filter(
          (value): value is string =>
            typeof value === 'string' && TRANSPORT_KINDS.some((transport) => transport === value),
        )
      : undefined
  return {
    id: result.name,
    elapsedMs,
    status: skip ? 'skipped' : result.ok ? 'passed' : cancelled ? 'cancelled' : 'failed',
    ...(skip
      ? { code: skipCode }
      : !result.ok
        ? { code: cancelled ? 'cancelled' : 'check-failed' }
        : {}),
    ...(transports ? { transports } : {}),
  }
}

export const summarizeDiagnostics = (results: readonly SharingDiagnosticResult[]) => ({
  passed: results.filter((result) => result.status === 'passed').length,
  failed: results.filter((result) => result.status === 'failed').length,
  skipped: results.filter((result) => result.status === 'skipped').length,
  cancelled: results.filter((result) => result.status === 'cancelled').length,
})

interface SharingDiagnosticCatalogEntry {
  id: string
  name: string
  category: string
  description: string
  guided?: boolean
  timeoutMs?: number
  fn: TaskyonTestFn
}

type SharingDiagnosticDependencySet = SharingDiagnosticDependencies & {
  includeGuided?: () => boolean
}

interface SharingDiagnosticState {
  readonly dependencies: SharingDiagnosticDependencySet
  phase: string
  readonly usedPartnerUrls: Set<string>
  readonly activeCases: Set<Promise<unknown>>
  caseDependencies: SharingDiagnosticDependencies
}

const createDiagnosticState = (
  dependencies: SharingDiagnosticDependencySet,
): SharingDiagnosticState => {
  const state: SharingDiagnosticState = {
    dependencies,
    phase: '',
    usedPartnerUrls: new Set(),
    activeCases: new Set(),
    caseDependencies: dependencies,
  }
  state.caseDependencies = {
    ...dependencies,
    stage: (message: string) => {
      state.phase = message
      dependencies.stage(message)
    },
  }
  return state
}

const nextPairing = async (state: SharingDiagnosticState, signal: AbortSignal) => {
  const pairing = state.dependencies.pairing()
  if (pairing.role !== 'join' || !state.usedPartnerUrls.has(pairing.url)) {
    if (pairing.role === 'join') state.usedPartnerUrls.add(pairing.url)
    return pairing
  }
  state.caseDependencies.stage('Paste or scan the host’s fresh link for this next check.')
  const next = await waitForDiagnosticValue(
    () => Promise.resolve(state.dependencies.pairing()),
    (candidate) => {
      if (state.usedPartnerUrls.has(candidate.url)) return false
      try {
        parseShareInvitation(candidate.url)
        return true
      } catch {
        return false
      }
    },
    signal,
  )
  state.usedPartnerUrls.add(next.url)
  return next
}

const trackActiveCase = <T extends Promise<unknown>>(
  state: SharingDiagnosticState,
  task: T,
): T => {
  state.activeCases.add(task)
  void task.finally(() => state.activeCases.delete(task)).catch(() => undefined)
  return task
}

const inDiagnosticSession = (
  state: SharingDiagnosticState,
  run: (session: ReturnType<SharingDiagnosticDependencies['createSession']>) => Promise<unknown>,
) => {
  const session = state.dependencies.createSession()
  const task = (async () => {
    try {
      return await run(session)
    } finally {
      await session.close()
      state.dependencies.invitation('')
    }
  })()
  return trackActiveCase(state, task)
}

const createPairedTest = (
  state: SharingDiagnosticState,
  kind: 'lifecycle' | 'expiry' | 'reconnect',
): TaskyonTestFn => {
  return async (context) => {
    if (state.dependencies.pairing().role === 'none') {
      return { skipped: true, reason: 'partner-required' }
    }
    const signal = context!.abortSignal!
    const pairing = await nextPairing(state, signal)
    return inDiagnosticSession(state, (session) =>
      runPairedDiagnostic(kind, session, { ...state.caseDependencies, pairing: () => pairing }, signal),
    )
  }
}

const checkCapabilities = (
  capabilities: ReturnType<SharingDiagnosticDependencies['capabilities']>,
): void => {
  if (!capabilities.secureContext || !capabilities.crypto || !capabilities.webRTC) {
    throw new Error('Required capability unavailable.')
  }
}

const assertMarkerZoom = (
  location: {
    id: string
    latitude: number
    longitude: number
    precision: 'approximate'
    radiusMeters: number
    color: string
  },
  zoom: number,
): void => {
  const features = createLocationFeatureCollection(
    [location, { ...location, id: 'synthetic-own', isOwn: true }],
    zoom,
  ).features
  if (
    features.length !== 2 ||
    features.some(
      (feature) =>
        feature.geometry.type !== (zoom === 8 ? 'Point' : 'Polygon') ||
        feature.properties.color !== location.color,
    )
  ) {
    throw new Error('Map behavior mismatch.')
  }
}

const checkLocationMarkers = (): void => {
  const location = {
    id: 'synthetic-peer',
    latitude: 40,
    longitude: 20,
    precision: 'approximate' as const,
    radiusMeters: 500,
    color: '#289a82',
  }
  for (const zoom of [8, 13]) assertMarkerZoom(location, zoom)
}

const capabilitiesEntry = (state: SharingDiagnosticState): SharingDiagnosticCatalogEntry => ({
  id: 'local.capabilities',
  name: 'Browser capabilities',
  category: 'local',
  description: 'Check secure context, encryption and real-time transport support.',
  fn: () => checkCapabilities(state.dependencies.capabilities()),
})

const markersEntry = (): SharingDiagnosticCatalogEntry => ({
  id: 'local.markers',
  name: 'Location markers',
  category: 'local',
  description: 'Check own and followed area/dot transitions and colors.',
  fn: () => checkLocationMarkers(),
})

const networkEntry = (state: SharingDiagnosticState): SharingDiagnosticCatalogEntry => ({
  id: 'network.reachability',
  name: 'Sharing network reachability',
  category: 'network',
  description: 'Create and close a temporary synthetic source through the configured network.',
  fn: () =>
    inDiagnosticSession(state, async (session) => {
      const share = await session.runtime.createShare(createShareDraft(), Date.now() + 60_000)
      await session.runtime.stopShare(share.shareId)
      return { transports: session.transports() }
    }),
})

const pairedEntry = (
  state: SharingDiagnosticState,
  kind: 'lifecycle' | 'expiry' | 'reconnect',
  name: string,
  description: string,
  guided = false,
): SharingDiagnosticCatalogEntry => ({
  id: `paired.${kind}`,
  name,
  category: 'paired',
  description,
  fn: createPairedTest(state, kind),
  timeoutMs: 180_000,
  ...(guided ? { guided: true } : {}),
})

const androidSkipReason = (dependencies: SharingDiagnosticDependencySet): string | undefined => {
  if (!dependencies.native) return 'android-required'
  if (dependencies.pairing().role !== 'host') return 'partner-required'
  if (!dependencies.nativeConsent?.()) return 'real-location-consent-required'
  return undefined
}

const runAndroidDiagnostic = async (
  state: SharingDiagnosticState,
  context: Parameters<TaskyonTestFn>[0],
): Promise<unknown> => {
  if (state.dependencies.pairing().role === 'join') {
    const pairing = await nextPairing(state, context!.abortSignal!)
    return inDiagnosticSession(state, (session) =>
      joinNativeDiagnostic(
        session,
        { ...state.caseDependencies, pairing: () => pairing },
        context!.abortSignal!,
      ),
    )
  }
  const reason = androidSkipReason(state.dependencies)
  if (reason) return { skipped: true, reason }
  return trackActiveCase(
    state,
    runNativeDiagnostic(state.caseDependencies, context!.abortSignal!),
  )
}

const androidEntry = (state: SharingDiagnosticState): SharingDiagnosticCatalogEntry => ({
  id: 'android.background',
  name: 'Android background check',
  category: 'android',
  description:
    'Explicit real-location test: pair, lock/unlock Android, verify delivery and revoke.',
  fn: (context) => runAndroidDiagnostic(state, context),
  timeoutMs: 180_000,
  guided: true,
})

const createCatalog = (state: SharingDiagnosticState): SharingDiagnosticCatalogEntry[] => [
  capabilitiesEntry(state),
  markersEntry(),
  networkEntry(state),
  pairedEntry(
    state,
    'lifecycle',
    'Two-way sharing and revocation',
    'Pair two devices; check updates, presence, private return sharing and revocation.',
  ),
  pairedEntry(
    state,
    'expiry',
    'Link expiry',
    'Pair using a new link that expires after one minute.',
    true,
  ),
  pairedEntry(
    state,
    'reconnect',
    'Network reconnect',
    'Temporarily disconnect the joining device, then restore its network.',
    true,
  ),
  androidEntry(state),
]

const selectedDiagnosticTests = (
  catalog: readonly SharingDiagnosticCatalogEntry[],
  selection: string,
): Record<string, TaskyonTestFn> => {
  const tests: Record<string, TaskyonTestFn> = {}
  for (const entry of catalog) {
    if (selection !== 'all' && entry.id !== selection && entry.category !== selection) continue
    tests[entry.id] = Object.assign(entry.fn, {
      timeoutMs: entry.timeoutMs,
      requiresLongRun: entry.guided,
    })
  }
  if (!Object.keys(tests).length) throw new Error('Unknown diagnostic selection.')
  return tests
}

const createRunOptions = (
  state: SharingDiagnosticState,
  catalog: readonly SharingDiagnosticCatalogEntry[],
  selection: string,
  signal: AbortSignal,
  results: SharingDiagnosticResult[],
  timing: { startedAt: number },
  onResult: (result: SharingDiagnosticResult) => void,
) => ({
  details: true,
  contextForTest: async (
    _name: string,
    _test: TaskyonTestFn,
    context: DiagnosticsTestContext,
  ) => {
    await Promise.allSettled([...state.activeCases])
    return context
  },
  context: {
    abortSignal: signal,
    allowLongRun:
      state.dependencies.includeGuided?.() ||
      catalog.some((entry) => entry.id === selection),
  },
  onProgress: (progress: { phase: string; test: string }) => {
    if (progress.phase !== 'start') return
    timing.startedAt = Date.now()
    state.caseDependencies.stage(`Running ${progress.test}.`)
  },
  onResult: (result: DiagnosticsRunResult) => {
    const safe = diagnosticResult(result, Date.now() - timing.startedAt, signal.aborted)
    safe.phase = state.phase
    results.push(safe)
    onResult(safe)
  },
})

const runCatalogSelection = async (
  state: SharingDiagnosticState,
  catalog: readonly SharingDiagnosticCatalogEntry[],
  selection: string,
  signal: AbortSignal,
  onResult: (result: SharingDiagnosticResult) => void,
): Promise<SharingDiagnosticResult[]> => {
  state.usedPartnerUrls.clear()
  const tests = selectedDiagnosticTests(catalog, selection)
  const results: SharingDiagnosticResult[] = []
  const timing = { startedAt: Date.now() }
  try {
    await runDiagnosticsTests(
      tests,
      createRunOptions(state, catalog, selection, signal, results, timing, onResult),
    )
  } finally {
    if (state.activeCases.size) state.dependencies.stage('Closing temporary diagnostic sessions…')
    await Promise.allSettled([...state.activeCases])
    state.dependencies.invitation('')
  }
  return results
}

export const createSharingDiagnostics = (
  dependencies: SharingDiagnosticDependencies & { includeGuided?: () => boolean },
) => {
  const state = createDiagnosticState(dependencies)
  const catalog = createCatalog(state)
  return {
    catalog: catalog.map(({ id, name, category, description, guided }) => ({
      id,
      name,
      category,
      description,
      guided: Boolean(guided),
    })),
    run: (selection: string, signal: AbortSignal, onResult: (result: SharingDiagnosticResult) => void) =>
      runCatalogSelection(state, catalog, selection, signal, onResult),
  }
}
