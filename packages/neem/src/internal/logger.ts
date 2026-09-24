import { resolve } from 'node:path'
import { threadId } from 'node:worker_threads'

import type { Level, Logger, StreamEntry } from 'pino'
import { levels, multistream, pino, stdTimeFunctions } from 'pino'
import { build as pretty } from 'pino-pretty'
import { errWithCause } from 'pino-std-serializers'

import type {
  NeemLoggerInput,
  NeemLoggerOptions,
  NeemMode,
} from '../shared/types.ts'
import type { ManifestLogger } from './manifest/manifest.ts'
import { importDefault } from './utils.ts'

export function childLogger(logger: Logger, label: string): Logger {
  return logger.child({ $label: label })
}

export function createLoggerFromConfigInput(
  mode: NeemMode,
  input: NeemLoggerInput | undefined,
): Logger {
  if (!input || typeof input === 'string' || input instanceof URL) {
    return createDefaultLogger(mode)
  }

  return createDefaultLogger(mode, input)
}

export async function resolveManifestLogger(
  logger: ManifestLogger | undefined,
  options: { mode: NeemMode; outDir: string; cacheBust?: boolean },
): Promise<Logger> {
  if (!logger) return createDefaultLogger(options.mode)
  if (logger.type === 'options') {
    return createDefaultLogger(options.mode, logger.options)
  }

  return importDefault<Logger>(resolve(options.outDir, logger.file), {
    cacheBust: options.cacheBust,
  })
}

type FlushableStream = { flush: (callback: (error?: Error) => void) => void }

/**
 * Waits until the logger's destinations report their buffered output written,
 * or `timeoutMs` passes; never rejects. A thread about to call `process.exit`
 * uses it so asynchronous destinations do not drop their last lines.
 *
 * Only `flush(cb)` reports completion, and pino's multistream (the default
 * logger's) has none, so its entries are flushed one by one. What this cannot
 * cover: streams without `flush(cb)` (e.g. pino-loki passed as a stream
 * rather than through `pino.transport()`) flush only by ending; a
 * `pino.transport()` stream's flush only waits for its thread to read the
 * lines, but pino ends it on process exit, which runs its close; a
 * `pino.destination({ sync: false })` with the default `minLength: 0` calls
 * back before its queued writes land.
 */
export function flushLogger(logger: Logger, timeoutMs: number): Promise<void> {
  const stream = loggerStream(logger)
  const streams: FlushableStream[] =
    stream === undefined
      ? [{ flush: (callback) => logger.flush(callback) }]
      : flushableStreams(stream)
  if (streams.length === 0) return Promise.resolve()

  return new Promise<void>((resolve) => {
    // Referenced on purpose: while an exiting thread waits here, this timer
    // keeps its event loop alive, so it cannot end early with another code.
    // An unbounded budget still needs a timer Node accepts (at most 2^31-1).
    const timer = setTimeout(
      resolve,
      Math.min(Math.max(0, timeoutMs), 2 ** 31 - 1),
    )
    const flushes = streams.map(
      (stream) =>
        new Promise<void>((done) => {
          try {
            // A flush error means the destination is gone; nothing to wait for.
            stream.flush(() => done())
          } catch {
            done()
          }
        }),
    )
    void Promise.all(flushes).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// A logger module is bundled with its own copy of pino, whose stream symbol is
// not the one this module imports, so the symbol is matched by description.
function loggerStream(logger: Logger): unknown {
  for (
    let target: object | null = logger;
    target;
    target = Object.getPrototypeOf(target) as object | null
  ) {
    const symbol = Object.getOwnPropertySymbols(target).find(
      (candidate) => candidate.description === 'pino.stream',
    )
    if (symbol) return (target as Record<symbol, unknown>)[symbol]
  }
  return undefined
}

function flushableStreams(stream: unknown): FlushableStream[] {
  if (!isRecord(stream)) return []
  if (Array.isArray(stream.streams)) {
    // A multistream: its entries are `{ stream }` wrappers.
    return stream.streams.flatMap((entry: unknown) =>
      isRecord(entry) ? flushableStreams(entry.stream) : [],
    )
  }
  return typeof stream.flush === 'function' ? [stream as FlushableStream] : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function runtimeLabel(runtimeName: string, threadName?: string): string {
  if (!threadName) return `runtime:${runtimeName}`
  const prefix = `${runtimeName}:`
  const normalized = threadName.startsWith(prefix)
    ? threadName.slice(prefix.length)
    : threadName
  return `runtime:${runtimeName}:${normalized}`
}

export function createDefaultLogger(
  mode: NeemMode = 'production',
  input: NeemLoggerOptions = {},
): Logger {
  if (process.env.NODE_ENV === 'test') {
    return pino({ enabled: false })
  }

  const pinoOptions = {
    level: mode === 'development' ? 'debug' : 'info',
    ...input.pinoOptions,
  }
  const destinations = input.destinations?.length
    ? input.destinations
    : [createConsoleDestination(pinoOptions.level as Level)]
  const stream = multistream(destinations)

  return pino(
    {
      timestamp: stdTimeFunctions.isoTime,
      ...pinoOptions,
      // Pino filters before routing, so admit the lowest destination threshold.
      level: levels.labels[stream.minLevel],
      serializers: {
        headers(value: unknown) {
          if (!(value instanceof Headers)) return value
          return Object.fromEntries(value.entries())
        },
        ...pinoOptions.serializers,
        err: errWithCause,
      },
      base: { $label: 'neem', $threadId: threadId },
    },
    stream,
  )
}

const levelColors: Record<number, number> = {
  10: 100,
  20: 102,
  30: 106,
  40: 104,
  50: 101,
  60: 105,
  [Number.POSITIVE_INFINITY]: 0,
}
const messageColors: Record<number, number> = {
  10: 0,
  20: 2,
  30: 6,
  40: 4,
  50: 1,
  60: 5,
  [Number.POSITIVE_INFINITY]: 0,
}
const levelLabels: Record<number, string> = {
  10: ' TRACE ',
  20: ' DEBUG ',
  30: ' INFO  ',
  40: ' WARN  ',
  50: ' ERROR ',
  60: ' FATAL ',
  [Number.POSITIVE_INFINITY]: 'SILENT',
}

function foreground(value: string, color: number): string {
  return `\x1b[38;5;${color}m${value}\x1b[0m`
}

function createConsoleDestination(level: Level): StreamEntry<Level> {
  return {
    level,
    stream: pretty({
      colorize: true,
      ignore: 'hostname,$label,$threadId',
      errorLikeObjectKeys: ['err', 'error', 'cause'],
      messageFormat(log, messageKey) {
        const group = foreground(`[${String(log.$label)}]`, 11)
        const message = foreground(
          String(log[messageKey]),
          messageColors[Number(log.level)],
        )
        const thread = foreground(`(T-${String(log.$threadId)})`, 89)
        return `\x1b[0m${thread} ${group} ${message}`
      },
      customPrettifiers: {
        level(value) {
          const level = Number(value)
          return `\x1b[${levelColors[level]}m${levelLabels[level]}\x1b[0m`
        },
      },
      sync: true,
    }),
  }
}
