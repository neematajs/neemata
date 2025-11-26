import type { Callback } from './types.ts'

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
    setTimeout(async () => {
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

export function debounce(cb: Callback, delay: number) {
  let timer: any
  const clear = () => timer && clearTimeout(timer)
  const fn = (...args: any[]) => {
    clear()
    timer = setTimeout(cb, delay, ...args)
  }
  return Object.assign(fn, { clear })
}

// TODO: Promise.withResolvers?
export interface Future<T = any> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: any) => void
  toArgs: () => [resolve: this['resolve'], reject: this['reject']]
}
// TODO: Promise.withResolvers?
export function createFuture<T>(): Future<T> {
  let resolve: Future<T>['resolve']
  let reject: Future<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // @ts-expect-error
  return { resolve, reject, promise, toArgs: () => [resolve, reject] }
}

export function onAbort<T extends Callback>(
  signal: AbortSignal,
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
) {
  return Promise.race([
    value,
    new Promise((_, reject) => setTimeout(reject, timeout, timeoutError)),
  ])
}

export function tryCaptureStackTrace(depth = 0) {
  const traceLines = new Error().stack?.split('\n')
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

export function once(target: EventTarget, event: string) {
  return new Promise<void>((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true })
  })
}

export function onceAborted(signal: AbortSignal) {
  return once(signal, 'abort')
}

export function isAbortError(error) {
  return (
    (error instanceof Error &&
      error.name === 'AbortError' &&
      'code' in error &&
      (error.code === 20 || error.code === 'ABORT_ERR')) ||
    (error instanceof Event && error.type === 'abort')
  )
}
