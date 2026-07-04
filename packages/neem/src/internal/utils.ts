import type { TimerOptions } from 'node:timers'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
    options.cacheBust ? `${href}?t=${Date.now()}` : href
  )) as EntryModule<T>
  return module.default
}

export function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
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
  // Non-Error values are normalized to an Error so name/stack are always present.
  return serializeErrorCore(value, {
    depth,
    fallback: (candidate) => serializeErrorCore(normalizeError(candidate)),
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

export function sanitizePathPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  )
}
