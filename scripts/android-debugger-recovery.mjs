const readOnlyOperations = [
  'android_background_share_status',
  'android_receiver_ownership',
  'android_load_private_state',
  'android_current_location',
  'document.readyState',
  'document.querySelector',
  'document.body',
]

export class DebuggerTransportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DebuggerTransportError'
  }
}

export class DebuggerTimeoutError extends DebuggerTransportError {
  constructor(message) {
    super(message)
    this.name = 'DebuggerTimeoutError'
  }
}

// Only evaluations that cannot change app state are safe to repeat after the
// debugger stalled: a state-changing command may already have reached the page.
export const readOnlyCdpOperation = (expression) =>
  readOnlyOperations.find((operation) => expression?.includes(operation))

export const evaluateReadOnlyWithRecovery = async ({
  expression,
  evaluate,
  reconnect,
  retries = 1,
}) => {
  let remaining = retries
  for (;;) {
    try {
      return await evaluate()
    } catch (error) {
      const recoverable =
        error instanceof DebuggerTransportError && Boolean(readOnlyCdpOperation(expression))
      if (!recoverable || remaining <= 0) throw error
      remaining -= 1
      await reconnect()
    }
  }
}
