const EVENT_CODES = [
  'app.started',
  'map.webgl.unavailable',
  'map.runtime.ready',
  'map.style.loaded',
  'map.error',
  'map.archive.verified',
  'map.archive.failed',
  'sharing.peer.status',
  'sharing.share.create.started',
  'sharing.share.create.succeeded',
  'sharing.share.create.failed',
  'sharing.follow.accept.started',
  'sharing.follow.accept.succeeded',
  'sharing.follow.accept.failed',
  'sharing.background.status',
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
] as const
const LOG_LIMIT = 2_000
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

export const createSessionLog = (now: () => number, mirror?: (entry: SessionLogEntry) => void) => {
  let entries: SessionLogEntry[] = []

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
      entries = [...entries.slice(0, -1), { ...last, repeatCount: last.repeatCount + 1 }]
      return
    }
    entries = [...entries, entry].slice(-LOG_LIMIT)
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
