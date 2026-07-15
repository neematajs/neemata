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
  return Promise.race([
    value,
    new Promise((_, reject) =>
      globalThis.setTimeout(() => {
        // fire the paired signal so in-flight work is actually cancelled,
        // not just raced away
        abortController?.abort(timeoutError)
        reject(timeoutError)
      }, timeout),
    ),
  ])
}

export function tryCaptureStackTrace(depth = 0) {
  const traceLines = new Error().stack?.split('\n').slice(depth)
  if (traceLines) {
    for (const traceLine of traceLines) {
      const trimmed = traceLine.trim()

      if (trimmed.startsWith('at eval (') && trimmed.endsWith(')')) {
        const trace = trimmed.slice(9, -1)
        return trace
      }
    }
  }
  return undefined
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
