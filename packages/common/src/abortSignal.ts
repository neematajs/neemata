const isNode =
  !('Bun' in globalThis) && globalThis.process?.release?.name === 'node'

/**
 * Combines multiple AbortSignals into one that aborts when any of the source signals abort.
 *
 * This is a custom implementation to work around memory leaks in Node.js's AbortSignal.any().
 * Bun's implementation is fine, so we use the native version there.
 *
 * @see https://github.com/nodejs/node/issues/54614
 */
export function anyAbortSignal(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const filtered = signals.filter(Boolean) as AbortSignal[]

  if (filtered.length === 0) {
    throw new Error('No AbortSignals provided')
  }

  if (filtered.length === 1) {
    return filtered[0]
  }

  // Use native implementation on Bun (no memory leak there)
  if (!isNode) {
    return AbortSignal.any(filtered)
  }

  // Custom implementation for Node.js to avoid memory leaks
  const controller = new AbortController()

  // Check if any signal is already aborted
  for (const signal of filtered) {
    if (signal.aborted) {
      controller.abort()
      return controller.signal
    }
  }

  // Track cleanup functions
  const cleanups: (() => void)[] = []

  const onAbort = (signal: AbortSignal) => {
    controller.abort(signal.reason)
    // Clean up all listeners immediately after abort
    cleanup()
  }

  const cleanup = () => {
    for (const fn of cleanups) {
      fn()
    }
    cleanups.length = 0
  }

  // Attach listeners to all signals
  for (const signal of filtered) {
    signal.addEventListener('abort', () => onAbort(signal), { once: true })
    cleanups.push(() =>
      signal.removeEventListener('abort', () => onAbort(signal)),
    )
  }

  return controller.signal
}
