import type { Pattern } from './types.ts'

export const noopFn = () => {}

export type Future<T = any> = PromiseWithResolvers<T>

export function createFuture<T>(): Future<T> {
  return Promise.withResolvers<T>()
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

export function throwError(message: string, ErrorClass = Error): never {
  throw new ErrorClass(message)
}

export function once(target: globalThis.EventTarget, event: string) {
  return new Promise<void>((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true })
  })
}

/**
 * Very simple pattern matching function.
 */
export function match(value: string, pattern: Pattern) {
  if (typeof pattern === 'function') return pattern(value)
  if (typeof pattern !== 'string') return pattern.test(value)
  if (pattern === '*' || pattern === '**') return true

  const leadingWildcard = pattern.at(0) === '*'
  const trailingWildcard = pattern.at(-1) === '*'

  if (leadingWildcard && trailingWildcard) {
    return value.includes(pattern.slice(1, -1))
  }
  if (trailingWildcard) return value.startsWith(pattern.slice(0, -1))
  if (leadingWildcard) return value.endsWith(pattern.slice(1))
  return value === pattern
}
