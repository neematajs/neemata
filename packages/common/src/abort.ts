import type { Callback } from './types.ts'

/**
 * Combines AbortSignals into one, skipping null/undefined slots so callers can
 * pass optional signals straight through. Throws on an empty list: there is no
 * signal to return, and a never-aborting stand-in would silently disable
 * cancellation for whoever forgot to pass one.
 */
export function anyAbortSignal(
  ...signals: (globalThis.AbortSignal | undefined | null)[]
): globalThis.AbortSignal {
  const filtered = signals.filter((signal) => !!signal)
  if (filtered.length === 0) {
    throw new Error('No AbortSignals provided')
  }
  if (filtered.length === 1) return filtered[0]

  return globalThis.AbortSignal.any(filtered)
}

export function onAbort<T extends Callback>(
  signal: globalThis.AbortSignal,
  cb: T,
  reason?: any,
) {
  const listener = () => cb(reason ?? signal.reason)
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

export function isAbortError(error: any): error is Error {
  return (
    (error instanceof Error &&
      error.name === 'AbortError' &&
      'code' in error &&
      (error.code === 20 || error.code === 'ABORT_ERR')) ||
    (error instanceof globalThis.Event && error.type === 'abort')
  )
}
