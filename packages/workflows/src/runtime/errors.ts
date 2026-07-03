import type { StoredError } from './state.ts'

const MAX_STORED_ERROR_CAUSE_DEPTH = 5

export function toStoredError(
  error: unknown,
  depth = MAX_STORED_ERROR_CAUSE_DEPTH,
): StoredError {
  if (error instanceof Error) {
    const cause = (error as Error & { readonly cause?: unknown }).cause
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(cause === undefined || depth <= 0
        ? {}
        : { cause: toStoredError(cause, depth - 1) }),
    }
  }

  if (isStoredError(error)) return error

  return { message: String(error) }
}

function isStoredError(error: unknown): error is StoredError {
  if (!error || typeof error !== 'object') return false
  if (!('message' in error) || typeof error.message !== 'string') return false

  const candidate = error as Partial<StoredError>
  return (
    (candidate.name === undefined || typeof candidate.name === 'string') &&
    (candidate.stack === undefined || typeof candidate.stack === 'string') &&
    (candidate.cause === undefined || isStoredError(candidate.cause))
  )
}
