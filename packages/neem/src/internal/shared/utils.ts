import type { TimerOptions } from 'node:timers'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

export type SerializedError = { message: string; name?: string; stack?: string }

export function serializeError(value: unknown): SerializedError {
  const error = normalizeError(value)
  return { message: error.message, name: error.name, stack: error.stack }
}

export function deserializeError(data: SerializedError): Error {
  const error = new Error(data.message)
  error.name = data.name ?? error.name
  error.stack = data.stack
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
