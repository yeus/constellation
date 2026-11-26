export const redactAndroidTestError = (message) =>
  message.replace(/#share=[A-Za-z0-9_-]+/g, '#share=<redacted>')

export const summarizeAndroidNativeCrash = (logs, applicationId) => ({
  appProcess: logs.includes(`>>> ${applicationId} <<<`),
  gpuThread: logs.includes('Chrome_InProcGp'),
  signals: ['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL'].filter((signal) => logs.includes(signal)),
  libraries: [
    'libconstellation_lib.so',
    'libwebviewchromium.so',
    'libart.so',
    'libc.so',
    'libhwui.so',
    'libEGL.so',
    'libGLESv2.so',
  ].filter((library) => logs.includes(library)),
  categories: [
    ['jni-error', /JNI DETECTED ERROR/],
    ['assertion', /Check failed|assertion .*failed/i],
    ['rust-panic', /panicked at|panic.*rust/i],
    ['allocation', /Out of memory|Failed to allocate|Scudo ERROR/i],
    ['thread-start', /pthread_create|failed to create.*thread/i],
    ['v8-fatal', /Fatal error.*v8|v8.*Fatal error/i],
    ['skia-glyph-mask', /SkGlyph\.cpp[^\r\n]*Unknown mask format/i],
    ['fdsan', /fdsan/i],
  ]
    .filter(([, pattern]) => pattern.test(logs))
    .map(([category]) => category),
})

export const readOptionalLogDirectory = (read) => {
  try {
    return read()
  } catch (error) {
    if (
      /^ls: cache\/shared-logs: No such file or directory\s*$/.test(
        String(error?.stderr ?? '').trim(),
      )
    )
      return ''
    throw error
  }
}

export const summarizeNotificationPause = (journal) =>
  journal
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(
        /^\d+ sharing\.pause\.request paused=(true|false);origin=(notification|ui)$/,
      )
      return match ? [{ paused: match[1] === 'true', origin: match[2] }] : []
    })
    .slice(-20)

const comparisonJournalSuffixes = {
  started: ['automatic', 'manual'],
  progress: [
    'preparing',
    'attempt-reserved',
    'stream-open',
    'challenge-received',
    'proof-verified',
    'result-stored',
  ],
  ready: ['sender', 'viewer'],
  presented: ['dialog', 'approval', 'preview'],
  failed: [
    'follow-changed',
    'timeout',
    'attempt-limit',
    'authentication',
    'storage',
    'cancelled',
    'expired',
    'unavailable',
    'transport',
    'other',
  ],
  confirmed: ['sender', 'viewer'],
  cancelled: ['sender', 'viewer'],
}

// Parse only the allowlisted native journal event name, not its arbitrary
// detail text. No peer, link, device secret or comparison letters can escape.
export const summarizeAndroidComparisonJournal = (journal) =>
  journal
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\d{13} ui\.sharing\.comparison\.([a-z-]+)(?:\.([a-z-]+))? /)
      if (!match) return []
      const allowed = comparisonJournalSuffixes[match[1]]
      if (!allowed || (match[2] && !allowed.includes(match[2]))) return []
      return [`${match[1]}${match[2] ? `.${match[2]}` : ''}`]
    })
    .slice(-24)
