import type { TimerOptions } from 'node:timers'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspect } from 'node:util'

import {
  MAX_SERIALIZED_ERROR_DEPTH,
  serializeError as serializeErrorCore,
} from '@nmtjs/common'

export type EntryModule<T> = { default: T }

export async function importDefault<T>(
  file: string | URL,
  options: { cacheBust?: boolean } = {},
): Promise<T> {
  const href =
    file instanceof URL
      ? file.href
      : file.startsWith('file:')
        ? file
        : pathToFileURL(file).href
  const module = (await import(
    options.cacheBust ? cacheBustSpecifier(href) : href
  )) as EntryModule<T>
  return module.default
}

// Bun keys its module registry by path for `file:` URLs and drops the query,
// so a busted file URL returns the cached module; a plain path with a query
// is re-evaluated on both runtimes.
function cacheBustSpecifier(href: string): string {
  const specifier = process.versions.bun ? fileURLToPath(href) : href
  return `${specifier}?t=${Date.now()}`
}

export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Throws every collected error at once so none of them is lost. */
export function throwCollected(
  errors: readonly Error[],
  message: string,
): void {
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(
    errors,
    `${message}: ${errors.map((error) => error.message).join('; ')}`,
  )
}

export type SerializedError = {
  message: string
  name?: string
  stack?: string
  cause?: SerializedError
}

export function serializeError(
  value: unknown,
  depth = MAX_SERIALIZED_ERROR_DEPTH,
): SerializedError {
  return serializeErrorCore(value, {
    depth,
    // Anything can be thrown or rejected; `String(value)` would flatten an
    // object to `[object Object]`, so render it the way a REPL would.
    fallback: (candidate) => ({ name: 'Error', message: inspect(candidate) }),
  })
}

export function deserializeError(data: SerializedError): Error {
  const error = new Error(
    data.message,
    data.cause ? { cause: deserializeError(data.cause) } : undefined,
  )
  error.name = data.name ?? error.name
  if (data.stack !== undefined) error.stack = data.stack
  return error
}

export function wait(ms: number, options?: TimerOptions): Promise<void> {
  return sleep(ms, undefined, options)
}

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  // Timers clamp values beyond 2^31-1 ms to 1 ms; an unbounded wait has no timer.
  if (!Number.isFinite(ms)) {
    return { timedOut: false, value: await promise }
  }
  const timeout = new AbortController()
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      wait(ms, { signal: timeout.signal }).then(() => ({
        timedOut: true as const,
      })),
    ])
  } finally {
    timeout.abort()
  }
}

export function toFilePath(entry: string | URL, cwd = process.cwd()): string {
  if (entry instanceof URL) return fileURLToPath(entry)
  if (entry.startsWith('file:')) return fileURLToPath(entry)
  return resolve(cwd, entry)
}

const SAFE_DIR_NAME = /^[A-Za-z0-9_-]+$/

/**
 * A directory name for an arbitrary name, such as a runtime's. Safe names stay
 * as they are; any other is base64url-encoded behind a `~`, which no safe name
 * contains, so two names never share a directory and none can traverse.
 */
export function toSafeDirName(name: string): string {
  if (SAFE_DIR_NAME.test(name)) return name
  return `~${Buffer.from(name, 'utf8').toString('base64url')}`
}

export function sanitizePathPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  )
}
