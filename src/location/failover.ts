import type { BrowserGeolocation, BrowserPositionError } from './browser.ts'

interface FailoverTimers {
  readonly setTimer?: (callback: () => void, delayMs: number) => number
  readonly clearTimer?: (timerId: number) => void
  readonly onFallback?: (reason: 'error' | 'timeout') => void
}

export const createFailoverGeolocation = (
  native: BrowserGeolocation,
  webview: BrowserGeolocation | undefined,
  timers: FailoverTimers = {},
): BrowserGeolocation => {
  const setTimer =
    timers.setTimer ??
    ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number)
  const clearTimer = timers.clearTimer ?? ((id) => globalThis.clearTimeout(id))
  let nextId = 0
  const watches = new Map<
    number,
    { stop: () => Promise<void>; provider: () => BrowserGeolocation }
  >()

  return {
    watchPosition: (success, error, options) => {
      const id = ++nextId
      let active = true
      let provider: BrowserGeolocation = native
      let providerWatchId: number | undefined
      let firstFix = false
      let fallbackAllowed = true
      let timerId: number | undefined

      const stopProvider = async (candidate = provider): Promise<void> => {
        if (timerId !== undefined) clearTimer(timerId)
        timerId = undefined
        const startedId = providerWatchId
        providerWatchId = undefined
        if (startedId !== undefined) await candidate.clearWatch(startedId)
      }
      const report = (failure: BrowserPositionError): void => {
        if (active) error?.(failure)
      }
      const startProvider = (candidate: BrowserGeolocation): void => {
        provider = candidate
        let started: number | Promise<number>
        try {
          started = candidate.watchPosition(
            (position) => {
              if (!active || provider !== candidate) return
              firstFix = true
              if (timerId !== undefined) clearTimer(timerId)
              timerId = undefined
              success(position)
            },
            (failure) => {
              if (!active || provider !== candidate) return
              if (candidate === native && failure.code !== 1 && failure.code !== 4 && webview) {
                switchToWebview('error')
              } else {
                fallbackAllowed = false
                if (timerId !== undefined) clearTimer(timerId)
                timerId = undefined
                report(failure)
              }
            },
            options,
          )
        } catch (failure) {
          handleStartFailure(candidate, failure)
          return
        }
        const acceptId = (startedId: number): void => {
          if (!active || provider !== candidate) {
            void candidate.clearWatch(startedId)
          } else {
            providerWatchId = startedId
            if (candidate === native && fallbackAllowed && !firstFix) {
              timerId = setTimer(() => {
                if (firstFix || !active || provider !== native || !fallbackAllowed) return
                if (webview) switchToWebview('timeout')
                else report({ code: 3 })
              }, 20_000)
            }
          }
        }
        if (typeof started === 'number') acceptId(started)
        else
          void started
            .then(acceptId)
            .catch((failure: unknown) => handleStartFailure(candidate, failure))
      }
      const switchToWebview = (reason: 'error' | 'timeout'): void => {
        if (!active || provider !== native || !webview) return
        timers.onFallback?.(reason)
        provider = webview
        void stopProvider(native)
          .then(() => {
            if (active) startProvider(webview)
          })
          .catch(() => report({ code: 2 }))
      }
      const handleStartFailure = (candidate: BrowserGeolocation, failure: unknown): void => {
        if (!active || provider !== candidate) return
        const code =
          typeof failure === 'object' && failure !== null && 'code' in failure
            ? Number(failure.code)
            : 2
        if (candidate === native && code !== 1 && code !== 4 && webview) {
          switchToWebview('error')
        } else {
          fallbackAllowed = false
          if (timerId !== undefined) clearTimer(timerId)
          timerId = undefined
          report({ code })
        }
      }

      watches.set(id, {
        provider: () => provider,
        stop: async () => {
          active = false
          await stopProvider()
        },
      })
      startProvider(native)
      return id
    },
    clearWatch: async (id) => {
      const watch = watches.get(id)
      watches.delete(id)
      await watch?.stop()
    },
    getCurrentPosition: (success, error, options) => {
      const provider = [...watches.values()].at(-1)?.provider() ?? native
      provider.getCurrentPosition?.(success, error, options)
    },
  }
}
