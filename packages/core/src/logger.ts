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

const bg = (value: string, color: number) => `\x1b[${color}m${value}\x1b[0m`
const fg = (value: string, color: number) =>
  `\x1b[38;5;${color}m${value}\x1b[0m`

// keyed by pino's numeric levels
const LEVELS: Record<number, { label: string; bg: number; fg: number }> = {
  10: { label: ' TRACE ', bg: 100, fg: 0 },
  20: { label: ' DEBUG ', bg: 102, fg: 2 },
  30: { label: ' INFO  ', bg: 106, fg: 6 },
  40: { label: ' WARN  ', bg: 104, fg: 4 },
  50: { label: ' ERROR ', bg: 101, fg: 1 },
  60: { label: ' FATAL ', bg: 105, fg: 5 },
  [Number.POSITIVE_INFINITY]: { label: 'SILENT', bg: 0, fg: 0 },
}

// pino's customLevels can emit numbers missing from the table
const levelStyle = (level: number) =>
  LEVELS[level] ?? { label: ` ${level} `, bg: 0, fg: 0 }

export const loggerLocalStorage = new AsyncLocalStorage<object | undefined>({
  defaultValue: undefined,
  name: 'NeemataAsyncLocalStorage',
})

export const createLogger = (options: LoggingOptions = {}, label: string) => {
  let { destinations } = options
  const { pinoOptions } = options

  if (!destinations?.length) {
    destinations = [
      createConsolePrettyDestination((pinoOptions?.level || 'info') as Level),
    ]
  }

  // the logger must pass everything the loudest destination wants to see
  let minimum = Number.POSITIVE_INFINITY
  for (const destination of destinations) {
    if (!('stream' in destination) || !destination.level) continue
    minimum = Math.min(minimum, levels.values[destination.level])
  }
  const level = levels.labels[minimum]
  const serializers = {
    headers: (value: unknown) => {
      if (!(value instanceof Headers)) return value

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
      base: { $label: label, $threadId: threadId },
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
      const msg = fg(String(log[messageKey]), levelStyle(Number(log.level)).fg)
      const thread = fg(`(T-${String(log.$threadId)})`, 89)
      return `\x1b[0m${thread} ${group} ${msg}`
    },
    customPrettifiers: {
      level: (level: any) => {
        const style = levelStyle(Number(level))
        return bg(style.label, style.bg)
      },
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
