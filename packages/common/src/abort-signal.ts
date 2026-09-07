/**
 * Little helper to combine multiple AbortSignals into one,
 * with handling of null or undefined values.
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
