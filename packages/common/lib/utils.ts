import type { Callback } from './types.ts'

export const noopFn = () => {}

export function merge<T extends any[]>(...objects: T) {
  return Object.assign({}, ...objects)
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
export type InteractivePromise<T = any> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: any) => void
  toArgs: () => [resolve: (value: T) => void, reject: (error: any) => void]
}

export function createPromise<T>(): InteractivePromise<T> {
  let resolve: InteractivePromise<T>['resolve']
  let reject: InteractivePromise<T>['reject']
  const promise = new Promise<T>((...args) => {
    resolve = args[0]
    reject = args[1]
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
  controller?: AbortController,
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(reject, timeout, timeoutError)
    const clearTimer = () => clearTimeout(timer)
    const rejectWithTimeout = (error: any) => {
      reject(error)
      controller?.abort(error)
    }
    value.then(resolve).catch(rejectWithTimeout).finally(clearTimer)
  })
}

export function tryCaptureStackTrace() {
  return new Error().stack?.split('\n').slice(3).join('\n') ?? undefined
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

export function throwError(message: string, ErrorClass = Error): never {
  throw new ErrorClass(message)
}
