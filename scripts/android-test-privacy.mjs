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
    ['fdsan', /fdsan/i],
  ]
    .filter(([, pattern]) => pattern.test(logs))
    .map(([category]) => category),
})
