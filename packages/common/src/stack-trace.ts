export type StackTraceAnchor = (...args: any[]) => any

/**
 * Captures the call-site location (`file:line:col`) of whoever called
 * `anchor` — every frame up to and including the anchor itself is omitted,
 * so wrappers attribute to their caller by passing their own reference
 * instead of counting stack frames.
 */
export function tryCaptureStackTrace(
  anchor: StackTraceAnchor = tryCaptureStackTrace,
) {
  // V8-only API, absent from the platform-neutral Error typings
  const { captureStackTrace } = Error as ErrorConstructor & {
    captureStackTrace?: (holder: object, anchor?: StackTraceAnchor) => void
  }
  const holder: { stack?: string } = {}
  if (typeof captureStackTrace === 'function') {
    captureStackTrace(holder, anchor)
  } else {
    // non-V8 fallback: anchors are not supported, approximate by skipping
    // this function's own frame — wrapper attribution may be one frame off
    holder.stack = new Error().stack?.split('\n').slice(1).join('\n')
  }

  const lines = holder.stack?.split('\n')
  if (!lines) return undefined
  // skip the error header
  for (const line of lines.slice(1)) {
    const frame = line.trim()
    if (!frame.startsWith('at ')) continue

    // keep the whole eval frame: it carries the original location of code
    // executed through eval-based dev runtimes
    if (frame.startsWith('at eval (') && frame.endsWith(')')) {
      return frame.slice(9, -1)
    }

    // `at fn (file:line:col)` or `at file:line:col`
    const parenthesized = frame.match(/\(([^()]*)\)$/)
    return parenthesized ? parenthesized[1] : frame.slice(3)
  }
  return undefined
}
