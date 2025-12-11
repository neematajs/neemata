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
    return new AbortController().signal
  }

  if (filtered.length === 1) {
    return filtered[0]
  }

  // Use native implementation on Bun (no memory leak there)
  if ('Bun' in globalThis) {
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

  const onAbort = () => {
    controller.abort()
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
    signal.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => signal.removeEventListener('abort', onAbort))
  }

  return controller.signal
}
