import type { Pattern } from '@nmtjs/common'
import type { Callback } from '../types.ts'

export const merge = (...objects: object[]) => Object.assign({}, ...objects)

export const defer = <T extends Callback>(
  cb: T,
  ms = 1,
  ...args: Parameters<T>
): Promise<Awaited<ReturnType<T>>> =>
  new Promise((resolve, reject) =>
    setTimeout(async () => {
      try {
        resolve(await cb(...args))
      } catch (error) {
        reject(error)
      }
    }, ms),
  )

/**
 * Very simple pattern matching function.
 */
export const match = (value: string, pattern: Pattern) => {
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

export const importDefault = (specifier: any) =>
  import(`${specifier}`).then((m) => m.default)

export const range = (count: number, start = 0) => {
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

export const debounce = (cb: Callback, delay: number) => {
  let timer: any
  const clear = () => timer && clearTimeout(timer)
  const fn = (...args: any[]) => {
    clear()
    timer = setTimeout(cb, delay, ...args)
  }
  return Object.assign(fn, { clear })
}

export const isJsFile = (name: string) => {
  if (name.endsWith('.d.ts')) return false
  const leading = name.split('.').slice(1)
  const ext = leading.join('.')
  return ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].includes(ext)
}

export type Future<T> = {
  resolve: (value: T) => void
  reject: (error?: any) => void
  promise: Promise<T>
  asArgs: [resolve: (value: T) => void, reject: (error: any) => void]
}

// TODO: Promise.withResolvers?
export const createFuture = <T>(): Future<T> => {
  let asArgs: [resolve: (value: T) => void, reject: (error: any) => void]
  const promise = new Promise<T>((...args) => (asArgs = args))
  const [resolve, reject] = asArgs!
  return { resolve, reject, promise, asArgs: asArgs! }
}

export const onAbort = <T extends Callback>(
  signal: AbortSignal,
  cb: T,
  reason?: any,
) => {
  const listener = () => cb(reason ?? signal.reason)
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

export const noop = () => {}

export const withTimeout = (
  value: Promise<any>,
  timeout: number,
  timeoutError: Error,
) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(reject, timeout, timeoutError)
    const clearTimer = () => clearTimeout(timer)
    value.then(resolve).catch(reject).finally(clearTimer)
  })

export const parseContentTypes = (types: string) => {
  if (types === '*/*') return ['*/*']
  return types
    .split(',')
    .map((t) => {
      const [type, ...rest] = t.split(';')
      const params = new Map(
        rest.map((p) =>
          p
            .trim()
            .split('=')
            .slice(0, 2)
            .map((p) => p.trim()),
        ) as [string, string][],
      )
      return {
        type,
        q: params.has('q') ? Number.parseFloat(params.get('q')!) : 1,
      }
    })
    .sort((a, b) => {
      if (a.type === '*/*') return 1
      if (b.type === '*/*') return -1
      return b.q - a.q ? -1 : 1
    })
    .map((t) => t.type)
}

export function tryCaptureStackTrace() {
  return new Error().stack?.split('\n').slice(3).join('\n') ?? undefined
}
