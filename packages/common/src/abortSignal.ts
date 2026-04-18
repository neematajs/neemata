/// <reference lib="dom" />

/**
 * Little helper to combine multiple AbortSignals into one,
 * with handling of null or undefined values.
 */
export function anyAbortSignal(
  ...signals: (AbortSignal | undefined | null)[]
): AbortSignal {
  const filtered = signals.filter(Boolean) as AbortSignal[]
  if (filtered.length === 0) {
    throw new Error('No AbortSignals provided')
  } else if (filtered.length === 1) {
    return filtered[0]
  } else {
    return AbortSignal.any(filtered)
  }
}
