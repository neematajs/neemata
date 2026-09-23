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
