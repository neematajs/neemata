import { AsyncLocalStorage } from 'node:async_hooks'
import { threadId } from 'node:worker_threads'

import type {
  Bindings,
  ChildLoggerOptions,
  DestinationStream,
  Level,
  Logger,
  LoggerOptions,
  StreamEntry,
} from 'pino'
import { levels, multistream, pino, stdTimeFunctions } from 'pino'
import { build as pretty } from 'pino-pretty'
import { errWithCause } from 'pino-std-serializers'

// TODO: use node:util inspect
const bg = (value, color) => `\x1b[${color}m${value}\x1b[0m`
const fg = (value, color) => `\x1b[38;5;${color}m${value}\x1b[0m`

const levelColors = {
  10: 100,
  20: 102,
  30: 106,
  40: 104,
  50: 101,
  60: 105,
  [Number.POSITIVE_INFINITY]: 0,
}
const messageColors = {
  10: 0,
  20: 2,
  30: 6,
  40: 4,
  50: 1,
  60: 5,
  [Number.POSITIVE_INFINITY]: 0,
}

const levelLabels = {
  10: ' TRACE ',
  20: ' DEBUG ',
  30: ' INFO  ',
  40: ' WARN  ',
  50: ' ERROR ',
  60: ' FATAL ',
  [Number.POSITIVE_INFINITY]: 'SILENT',
}

export const loggerLocalStorage = new AsyncLocalStorage<object | undefined>({
  defaultValue: undefined,
  name: 'NeemataAsyncLocalStorage',
})

export const createLogger = (options: LoggingOptions = {}, $label: string) => {
  let { destinations } = options
  const { pinoOptions } = options

  if (!destinations?.length) {
    destinations = [
      createConsolePrettyDestination((pinoOptions?.level || 'info') as Level),
    ]
  }

  let minimum = Number.POSITIVE_INFINITY
  for (const destination of destinations) {
    if (!('stream' in destination)) continue
    minimum = Math.min(minimum, levels.values[destination.level!])
  }
  const level = levels.labels[minimum]
  const serializers = {
    headers: (value: unknown) => {
      if (value instanceof Headers === false) return value

      const headers: Record<string, string> = {}
      value.forEach((value, name) => {
        headers[name] = value
      })
      return headers
    },
    ...pinoOptions?.serializers,
    err: errWithCause,
  }

  return pino(
    {
      timestamp: stdTimeFunctions.isoTime,
      ...pinoOptions,
      level,
      serializers,
      formatters: {
        log(object) {
          const bindings = loggerLocalStorage.getStore()
          if (bindings) {
            return Object.assign(object, bindings)
          }
          return object
        },
      },
      base: { $label, $threadId: threadId },
    },
    multistream(destinations),
  )
}

export const forkLogger = (
  logger: Logger,
  label: string | undefined,
  options?: ChildLoggerOptions,
  bindings?: Bindings,
) => {
  const childBindings = { ...bindings }
  if (label !== undefined) childBindings.$label = label
  return logger.child(childBindings, options)
}

export type CreateConsolePrettyDestination = (
  level: Level,
  sync?: boolean,
) => StreamEntry

export const createConsolePrettyDestination: CreateConsolePrettyDestination = (
  level,
  sync = true,
) => ({
  level,
  stream: pretty({
    colorize: true,
    ignore: 'hostname,$label,$threadId',
    errorLikeObjectKeys: ['err', 'error', 'cause'],
    messageFormat: (log, messageKey) => {
      const group = fg(`[${String(log.$label)}]`, 11)
      const msg = fg(
        String(log[messageKey]),
        messageColors[log.level as number],
      )
      const thread = fg(`(T-${String(log.$threadId)})`, 89)
      return `\x1b[0m${thread} ${group} ${msg}`
    },
    customPrettifiers: {
      level: (level: any) => bg(levelLabels[level], levelColors[level]),
    },
    sync,
  }),
})

export type {
  ChildLoggerOptions,
  DestinationStream,
  Level,
  Logger,
  LoggerOptions,
  StreamEntry,
}

export type LoggingOptions = {
  destinations?: Array<DestinationStream | StreamEntry<Level>>
  pinoOptions?: LoggerOptions
}
