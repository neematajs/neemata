import { MAX_UINT32 } from '@nmtjs/common'

/**
 * Resolves (never rejects) when the signal aborts, so callers re-check their
 * own state instead of handling a rejection.
 */
export const sleep = (ms: number, signal?: AbortSignal) => {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()

    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// call and stream ids are uint32 on the wire, so they wrap instead of growing
export const createIdCounter = () => {
  let id = 0

  return () => {
    if (id >= MAX_UINT32) id = 0
    return id++
  }
}

export const isOffline = () => {
  if (!globalThis.window || !('navigator' in globalThis.window)) return false
  return globalThis.window.navigator?.onLine === false
}

export const isTabHidden = () => {
  return globalThis.document?.visibilityState === 'hidden'
}

export const toReasonString = (reason: unknown) => {
  if (typeof reason === 'string') return reason
  if (reason === undefined || reason === null) return undefined
  if (reason instanceof Error) return reason.message

  try {
    // JSON.stringify returns undefined (does not throw) for symbols/functions
    const json = JSON.stringify(reason)
    if (json !== undefined) return json
  } catch {}

  // bigint makes JSON.stringify throw, symbols make it return undefined
  if (typeof reason === 'bigint' || typeof reason === 'symbol') {
    return reason.toString()
  }

  return Object.prototype.toString.call(reason)
}
