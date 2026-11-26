const EVENT_CODES = [
  'app.started',
  'app.visibility',
  'app.connectivity',
  'sharing.background.following',
  'sharing.background.following.preference',
  'sharing.background.following.preference.loaded',
  'android.power.optimization',
  'android.power.saver',
  'android.power.restricted',
  'android.network.data-saver',
  'map.webgl.unavailable',
  'map.runtime.ready',
  'map.style.loaded',
  'map.error',
  'map.archive.verified',
  'map.archive.failed',
  'map.cache.cleared',
  'sharing.peer.status',
  'sharing.share.create.started',
  'sharing.share.create.succeeded',
  'sharing.share.create.failed',
  'sharing.follow.accept.started',
  'sharing.follow.accept.succeeded',
  'sharing.follow.accept.failed',
  'sharing.app_handoff.launch',
  'sharing.app_handoff.copy',
  'sharing.app_handoff.dismissed',
  'sharing.follow.status',
  'sharing.network.connections',
  'sharing.background.status',
  'sharing.background.peer',
  'sharing.background.viewers',
  'sharing.background.location',
  'sharing.background.connections',
  'sharing.background.history',
  'location.provider.fallback',
  'location.device.services',
  'sharing.session.lifecycle',
  'sharing.comparison.started',
  'sharing.comparison.progress',
  'sharing.comparison.ready',
  'sharing.comparison.presented',
  'sharing.comparison.failed',
  'sharing.comparison.confirmed',
  'sharing.comparison.cancelled',
] as const

const CATEGORIES = [
  'glyph',
  'sprite',
  'tile',
  'cors',
  'network',
  'webgl',
  'style',
  'unknown',
] as const
const STATES = [
  'offline',
  'connecting',
  'online',
  'error',
  'starting',
  'sharing',
  'paused',
  'stopped',
  'connected',
  'disconnected',
  'visible',
  'hidden',
  'enabled',
  'disabled',
] as const
const LOG_LIMIT = 40_000
const REPEAT_WINDOW_MS = 10_000

export interface SessionLogInput {
  readonly level: 'info' | 'warning' | 'error'
  readonly event: (typeof EVENT_CODES)[number]
  readonly category?: (typeof CATEGORIES)[number]
  readonly state?: (typeof STATES)[number]
  readonly message?: string
}

export interface SessionLogEntry extends SessionLogInput {
  readonly timestampMs: number
  readonly repeatCount: number
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message
    if (typeof message === 'string') return message
  }
  return 'Unknown error.'
}

export const redactDiagnosticMessage = (message: string): string =>
  message
    .replace(/\b-?\d{1,3}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\b/g, '[coordinates]')
    .replace(/\b\d+\/\d+\/\d+\b/g, '[tile coordinates]')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[resource URL]')
    .replace(
      /(?:#share=|\b(?:share|secret|token|key|peerid|latitude|longitude|lat|lon)=)[^\s&]+/gi,
      '[secret]',
    )
    .replace(/\/(?:ip4|ip6|dns4|dns6|p2p)\/[^\s"'<>]+/gi, '[network address]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[network address]')
    .replace(/(?:\/home\/|\/Users\/|\/workspace\/|\/sandbox-home\/)[^\s"'<>]+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[local path]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[identifier]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)

export const describeDiagnosticError = (
  error: unknown,
): {
  category: (typeof CATEGORIES)[number]
  message: string
} => {
  const message = errorMessage(error)
  const category = /cors|cross.origin|access.control.allow.origin/i.test(message)
    ? 'cors'
    : /glyph|fontstack/i.test(message)
      ? 'glyph'
      : /sprite|image/i.test(message)
        ? 'sprite'
        : /webgl|webgl2/i.test(message)
          ? 'webgl'
          : /fetch|network|load failed|ajaxerror/i.test(message)
            ? 'network'
            : /tile|pmtiles/i.test(message)
              ? 'tile'
              : /style|layer|source/i.test(message)
                ? 'style'
                : 'unknown'
  return { category, message: redactDiagnosticMessage(message) }
}

// Never export peer identities, challenges, shared secrets or comparison letters.
// Keep failure reasons bounded to a stable vocabulary suitable for both devices.
export const deviceComparisonFailureReason = (
  error: unknown,
):
  | 'follow-changed'
  | 'timeout'
  | 'attempt-limit'
  | 'authentication'
  | 'storage'
  | 'cancelled'
  | 'expired'
  | 'unavailable'
  | 'transport'
  | 'other' => {
  const message = errorMessage(error)
  if (/follow-state change|follow state change/i.test(message)) return 'follow-changed'
  if (/timed out|timeout|deadline/i.test(message)) return 'timeout'
  if (/attempts exhausted|attempt limit/i.test(message)) return 'attempt-limit'
  if (/authenticated.*mismatch|device comparison denied|invalid proof/i.test(message))
    return 'authentication'
  if (/private storage|protected storage|storage fail|could not save/i.test(message))
    return 'storage'
  if (/cancelled|canceled|abort/i.test(message)) return 'cancelled'
  if (/expired|expiry/i.test(message)) return 'expired'
  if (/comparison is unavailable|comparison unavailable/i.test(message)) return 'unavailable'
  if (/transport|connection|stream|dial|network|closed/i.test(message)) return 'transport'
  return 'other'
}

// The native crash journal accepts only a short event code plus enum state.
// Encode an allowlisted phase into the event name so it survives an Activity
// restart without persisting any comparison challenge or secret.
export const nativeSessionEventName = (
  entry: Pick<SessionLogInput, 'event' | 'message'>,
): string => {
  if (!entry.event.startsWith('sharing.comparison.')) return entry.event
  const message = entry.message ?? ''
  const phase =
    /\bstage=(attempt-reserved|stream-open|challenge-received|proof-verified|result-stored|preparing)\b/.exec(
      message,
    )?.[1]
  const reason =
    /\breason=(follow-changed|timeout|attempt-limit|authentication|storage|cancelled|expired|unavailable|transport|other)\b/.exec(
      message,
    )?.[1]
  const surface = /\bsurface=(dialog|approval|preview)\b/.exec(message)?.[1]
  const trigger = /\btrigger=(automatic|manual)\b/.exec(message)?.[1]
  const role = /\brole=(sender|viewer)\b/.exec(message)?.[1]
  const detail =
    entry.event === 'sharing.comparison.progress'
      ? phase
      : entry.event === 'sharing.comparison.failed'
        ? reason
        : entry.event === 'sharing.comparison.presented'
          ? surface
          : entry.event === 'sharing.comparison.started'
            ? trigger
            : role
  return detail ? `${entry.event}.${detail}` : entry.event
}

export const createSessionLog = (now: () => number, mirror?: (entry: SessionLogEntry) => void) => {
  const entries: SessionLogEntry[] = []

  const record = (input: SessionLogInput): void => {
    if (!EVENT_CODES.includes(input.event)) return
    const entry: SessionLogEntry = {
      timestampMs: now(),
      level: input.level,
      event: input.event,
      repeatCount: 1,
      ...(input.category && CATEGORIES.includes(input.category)
        ? { category: input.category }
        : {}),
      ...(input.state && STATES.includes(input.state) ? { state: input.state } : {}),
      ...(input.message ? { message: redactDiagnosticMessage(input.message) } : {}),
    }
    const last = entries.at(-1)
    if (
      entry.level === 'error' &&
      last?.event === entry.event &&
      last.category === entry.category &&
      last.message === entry.message &&
      entry.timestampMs - last.timestampMs <= REPEAT_WINDOW_MS
    ) {
      entries[entries.length - 1] = { ...last, repeatCount: last.repeatCount + 1 }
      return
    }
    entries.push(entry)
    if (entries.length > LOG_LIMIT) entries.shift()
    mirror?.(entry)
  }

  const snapshot = (): readonly SessionLogEntry[] => [...entries]
  const format = (runtime: 'browser' | 'desktop' | 'android'): string => {
    const body = entries.map((entry) => {
      const details = [entry.category, entry.state, entry.message].filter(Boolean).join(' · ')
      const repeats = entry.repeatCount > 1 ? ` (repeated ${entry.repeatCount} times)` : ''
      return `${new Date(entry.timestampMs).toISOString()} [${entry.level.toUpperCase()}] ${entry.event}${details ? ` · ${details}` : ''}${repeats}`
    })
    return ['Constellation session logs', `Runtime: ${runtime}`, ...body].join('\n')
  }

  return { record, snapshot, format }
}
