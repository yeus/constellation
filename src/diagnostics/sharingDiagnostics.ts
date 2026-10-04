import {
  getDiagnosticsSkipReason,
  runDiagnosticsTests,
  type DiagnosticsRunResult,
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

export const createSharingDiagnostics = (
  dependencies: SharingDiagnosticDependencies & { includeGuided?: () => boolean },
) => {
  let phase = ''
  const usedPartnerUrls = new Set<string>()
  const nextPairing = async (signal: AbortSignal) => {
    const pairing = dependencies.pairing()
    if (pairing.role !== 'join' || !usedPartnerUrls.has(pairing.url)) {
      if (pairing.role === 'join') usedPartnerUrls.add(pairing.url)
      return pairing
    }
    caseDependencies.stage('Paste or scan the host’s fresh link for this next check.')
    const next = await waitForDiagnosticValue(
      () => Promise.resolve(dependencies.pairing()),
      (candidate) => {
        if (usedPartnerUrls.has(candidate.url)) return false
        try {
          parseShareInvitation(candidate.url)
          return true
        } catch {
          return false
        }
      },
      signal,
    )
    usedPartnerUrls.add(next.url)
    return next
  }
  const caseDependencies = {
    ...dependencies,
    stage: (message: string) => {
      phase = message
      dependencies.stage(message)
    },
  }
  const activeCases = new Set<Promise<unknown>>()
  const inSession = (
    run: (session: ReturnType<SharingDiagnosticDependencies['createSession']>) => Promise<unknown>,
  ) => {
    const session = dependencies.createSession()
    const task = (async () => {
      try {
        return await run(session)
      } finally {
        await session.close()
        dependencies.invitation('')
      }
    })()
    activeCases.add(task)
    void task.finally(() => activeCases.delete(task)).catch(() => undefined)
    return task
  }
  const paired =
    (kind: 'lifecycle' | 'expiry' | 'reconnect'): TaskyonTestFn =>
    async (context) => {
      if (dependencies.pairing().role === 'none')
        return { skipped: true, reason: 'partner-required' }
      const signal = context!.abortSignal!
      const pairing = await nextPairing(signal)
      return inSession((session) =>
        runPairedDiagnostic(kind, session, { ...caseDependencies, pairing: () => pairing }, signal),
      )
    }
  const catalog = [
    {
      id: 'local.capabilities',
      name: 'Browser capabilities',
      category: 'local',
      description: 'Check secure context, encryption and real-time transport support.',
      fn: () => {
        const capabilities = dependencies.capabilities()
        if (!capabilities.secureContext || !capabilities.crypto || !capabilities.webRTC)
          throw new Error('Required capability unavailable.')
      },
    },
    {
      id: 'local.markers',
      name: 'Location markers',
      category: 'local',
      description: 'Check own and followed area/dot transitions and colors.',
      fn: () => {
        const location = {
          id: 'synthetic-peer',
          latitude: 40,
          longitude: 20,
          precision: 'approximate' as const,
          radiusMeters: 500,
          color: '#289a82',
        }
        for (const zoom of [8, 13]) {
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
          )
            throw new Error('Map behavior mismatch.')
        }
      },
    },
    {
      id: 'network.reachability',
      name: 'Sharing network reachability',
      category: 'network',
      description: 'Create and close a temporary synthetic source through the configured network.',
      fn: () =>
        inSession(async (session) => {
          const share = await session.runtime.createShare(createShareDraft(), Date.now() + 60_000)
          await session.runtime.stopShare(share.shareId)
          return { transports: session.transports() }
        }),
    },
    {
      id: 'paired.lifecycle',
      name: 'Two-way sharing and revocation',
      category: 'paired',
      description:
        'Pair two devices; check updates, presence, private return sharing and revocation.',
      fn: paired('lifecycle'),
      timeoutMs: 180_000,
    },
    {
      id: 'paired.expiry',
      name: 'Link expiry',
      category: 'paired',
      description: 'Pair using a new link that expires after one minute.',
      fn: paired('expiry'),
      timeoutMs: 180_000,
      guided: true,
    },
    {
      id: 'paired.reconnect',
      name: 'Network reconnect',
      category: 'paired',
      description: 'Temporarily disconnect the joining device, then restore its network.',
      fn: paired('reconnect'),
      timeoutMs: 180_000,
      guided: true,
    },
    {
      id: 'android.background',
      name: 'Android background check',
      category: 'android',
      description:
        'Explicit real-location test: pair, lock/unlock Android, verify delivery and revoke.',
      fn: async (context: Parameters<TaskyonTestFn>[0]) => {
        if (dependencies.pairing().role === 'join') {
          const pairing = await nextPairing(context!.abortSignal!)
          return inSession((session) =>
            joinNativeDiagnostic(
              session,
              { ...caseDependencies, pairing: () => pairing },
              context!.abortSignal!,
            ),
          )
        }
        if (!dependencies.native) return { skipped: true, reason: 'android-required' }
        if (dependencies.pairing().role !== 'host')
          return { skipped: true, reason: 'partner-required' }
        if (!dependencies.nativeConsent?.())
          return { skipped: true, reason: 'real-location-consent-required' }
        const task = runNativeDiagnostic(caseDependencies, context!.abortSignal!)
        activeCases.add(task)
        void task.finally(() => activeCases.delete(task)).catch(() => undefined)
        return task
      },
      timeoutMs: 180_000,
      guided: true,
    },
  ]
  return {
    catalog: catalog.map(({ id, name, category, description, guided }) => ({
      id,
      name,
      category,
      description,
      guided: Boolean(guided),
    })),
    run: async (
      selection: string,
      signal: AbortSignal,
      onResult: (result: SharingDiagnosticResult) => void,
    ) => {
      usedPartnerUrls.clear()
      const tests: Record<string, TaskyonTestFn> = {}
      for (const entry of catalog.filter(
        (test) => selection === 'all' || test.id === selection || test.category === selection,
      )) {
        tests[entry.id] = Object.assign(entry.fn, {
          timeoutMs: entry.timeoutMs,
          requiresLongRun: entry.guided,
        })
      }
      if (!Object.keys(tests).length) throw new Error('Unknown diagnostic selection.')
      const results: SharingDiagnosticResult[] = []
      let startedAt = Date.now()
      try {
        await runDiagnosticsTests(tests, {
          details: true,
          contextForTest: async (_name, _test, context) => {
            await Promise.allSettled([...activeCases])
            return context
          },
          context: {
            abortSignal: signal,
            allowLongRun:
              dependencies.includeGuided?.() || catalog.some((entry) => entry.id === selection),
          },
          onProgress: (progress) => {
            if (progress.phase === 'start') {
              startedAt = Date.now()
              caseDependencies.stage(`Running ${progress.test}.`)
            }
          },
          onResult: (result) => {
            const safe = diagnosticResult(result, Date.now() - startedAt, signal.aborted)
            safe.phase = phase
            results.push(safe)
            onResult(safe)
          },
        })
      } finally {
        if (activeCases.size) dependencies.stage('Closing temporary diagnostic sessions…')
        await Promise.allSettled([...activeCases])
        dependencies.invitation('')
      }
      return results
    },
  }
}
