export type SerializedError = {
  readonly name?: string
  readonly message: string
  readonly stack?: string
  readonly cause?: SerializedError
}

// Depth-limited so a cyclic cause chain cannot recurse forever.
export const MAX_SERIALIZED_ERROR_DEPTH = 5

export type SerializeErrorOptions = {
  depth?: number
  // Whether to drop the `stack` key when it is undefined instead of emitting it.
  omitUndefinedStack?: boolean
  // Handles values that are not Error instances (callers differ: normalize vs. passthrough).
  fallback?: (value: unknown) => SerializedError
}

export function serializeError(
  value: unknown,
  options: SerializeErrorOptions = {},
): SerializedError {
  const {
    depth = MAX_SERIALIZED_ERROR_DEPTH,
    omitUndefinedStack = false,
    fallback,
  } = options

  if (value instanceof Error) {
    const cause = (value as Error & { readonly cause?: unknown }).cause
    return {
      name: value.name,
      message: value.message,
      ...(omitUndefinedStack && value.stack === undefined
        ? {}
        : { stack: value.stack }),
      ...(cause === undefined || depth <= 0
        ? {}
        : { cause: serializeError(cause, { ...options, depth: depth - 1 }) }),
    }
  }

  return fallback ? fallback(value) : { message: String(value) }
}
