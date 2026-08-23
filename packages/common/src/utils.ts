import type { Callback, Pattern } from './types.ts'

export const noopFn = () => {}

export function merge<T extends any[]>(...objects: T) {
  return Object.assign({}, ...objects)
}

export function unique<T>(array: Iterable<T>): Iterable<T> {
  return new Set(array).values()
}

export function defer<T extends Callback>(
  cb: T,
  ms = 1,
  ...args: Parameters<T>
): Promise<Awaited<ReturnType<T>>> {
  return new Promise((resolve, reject) =>
    globalThis.setTimeout(async () => {
      try {
        resolve(await cb(...args))
      } catch (error) {
        reject(error)
      }
    }, ms),
  )
}

export function range(count: number, start = 0) {
  let current = start
  return {
    [Symbol.iterator]() {
      return {
        next() {
          if (current < count) {
            return { done: false, value: current++ }
          } else {
            return { done: true, value: current }
          }
        },
      }
    },
  }
}

export type Future<T = any> = PromiseWithResolvers<T>

export function createFuture<T>(): Future<T> {
  return Promise.withResolvers<T>()
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

export function withTimeout(
  value: Promise<any>,
  timeout: number,
  timeoutError: Error,
  abortController?: AbortController,
) {
  let timer: ReturnType<typeof globalThis.setTimeout>
  return Promise.race([
    value,
    new Promise((_, reject) => {
      timer = globalThis.setTimeout(() => {
        // fire the paired signal so in-flight work is actually cancelled,
        // not just raced away
        abortController?.abort(timeoutError)
        reject(timeoutError)
      }, timeout)
    }),
  ]).finally(() => {
    // otherwise a settled call would still get aborted at the deadline
    globalThis.clearTimeout(timer)
  })
}

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
  const captureStackTrace: (holder: object, anchor?: StackTraceAnchor) => void =
    (Error as any).captureStackTrace
  const holder: { stack?: string } = {}
  if (typeof captureStackTrace === 'function') {
    captureStackTrace(holder, anchor)
  } else {
    // non-V8 fallback: anchors are not supported, approximate by skipping
    // this function's own frame — wrapper attribution may be one frame off
    holder.stack = new Error().stack?.split('\n').slice(1).join('\n')
  }

  const findLocation = (stack?: string) => {
    const traceLines = stack?.split('\n')
    if (!traceLines) return undefined
    // skip the error header
    for (const traceLine of traceLines.slice(1)) {
      const trimmed = traceLine.trim()
      if (!trimmed.startsWith('at ')) continue

      // keep the whole eval frame: it carries the original location of code
      // executed through eval-based dev runtimes
      if (trimmed.startsWith('at eval (') && trimmed.endsWith(')')) {
        return trimmed.slice(9, -1)
      }

      // `at fn (file:line:col)` or `at file:line:col`
      const parenthesized = trimmed.match(/\(([^()]*)\)$/)
      return parenthesized ? parenthesized[1] : trimmed.slice(3)
    }
    return undefined
  }

  return findLocation(holder.stack)
}

export function isGeneratorFunction(value: any): value is GeneratorFunction {
  return (
    typeof value === 'function' &&
    value.constructor.name === 'GeneratorFunction'
  )
}

export function isAsyncGeneratorFunction(
  value: any,
): value is AsyncGeneratorFunction {
  return (
    typeof value === 'function' &&
    value.constructor.name === 'AsyncGeneratorFunction'
  )
}
export function isAsyncIterable(value: any): value is AsyncIterable<unknown> {
  return value && typeof value === 'object' && Symbol.asyncIterator in value
}

export function throwError(message: string, ErrorClass = Error): never {
  throw new ErrorClass(message)
}

export function once(target: globalThis.EventTarget, event: string) {
  return new Promise<void>((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true })
  })
}

export function onceAborted(signal: globalThis.AbortSignal) {
  return once(signal, 'abort')
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

/**
 * Very simple pattern matching function.
 */
export function match(value: string, pattern: Pattern) {
  if (typeof pattern === 'function') {
    return pattern(value)
  } else if (typeof pattern === 'string') {
    if (pattern === '*' || pattern === '**') {
      return true
    } else if (pattern.at(0) === '*' && pattern.at(-1) === '*') {
      return value.includes(pattern.slice(1, -1))
    } else if (pattern.at(-1) === '*') {
      return value.startsWith(pattern.slice(0, -1))
    } else if (pattern.at(0) === '*') {
      return value.endsWith(pattern.slice(1))
    } else {
      return value === pattern
    }
  } else {
    return pattern.test(value)
  }
}

export const isError = (value: any): value is Error => {
  if ('isError' in Error && typeof Error.isError === 'function') {
    return Error.isError(value)
  } else {
    return value instanceof Error
  }
}
