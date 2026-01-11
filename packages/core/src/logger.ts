import { threadId } from 'node:worker_threads'

import type * as pinoType from 'pino'
import { pino, stdTimeFunctions } from 'pino'
import { build as pretty } from 'pino-pretty'

export type { StreamEntry } from 'pino'
export type Logger = pinoType.Logger
export type LoggerOptions = pinoType.LoggerOptions
export type LoggerChildOptions = pinoType.ChildLoggerOptions
export type LoggingOptions = {
  destinations?: Array<
    pinoType.DestinationStream | pinoType.StreamEntry<pinoType.Level>
  >
  pinoOptions?: LoggerOptions
}

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

export const createLogger = (options: LoggingOptions = {}, $label: string) => {
  let { destinations, pinoOptions } = options

  if (!destinations || !destinations?.length) {
    destinations = [
      createConsolePrettyDestination(
        (options.pinoOptions?.level || 'info') as pinoType.Level,
      ),
    ]
  }

  const lowestLevelValue = destinations!.reduce(
    (acc, destination) =>
      Math.min(
        acc,
        'stream' in destination
          ? pino.levels.values[destination.level!]
          : Number.POSITIVE_INFINITY,
      ),
    Number.POSITIVE_INFINITY,
  )
  const level = pino.levels.labels[lowestLevelValue]
  const serializers = {
    headers: (value: any) => {
      if (value instanceof Headers) {
        const obj = {}
        value.forEach((v, k) => (obj[k] = v))
        return obj
      }
      return value
    },
    ...pinoOptions?.serializers,
    err: errWithCause,
  }

  return pino(
    { timestamp: stdTimeFunctions.isoTime, ...pinoOptions, level, serializers },
    pino.multistream(destinations!),
  ).child({ $label, $threadId: threadId })
}

export type CreateConsolePrettyDestination = (
  level: pinoType.Level,
  sync?: boolean,
) => pinoType.StreamEntry

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
      const group = fg(`[${log.$label}]`, 11)
      const msg = fg(log[messageKey], messageColors[log.level as number])
      const thread = fg(`(Thread-${log.$threadId})`, 89)
      return `\x1b[0m${thread} ${group} ${msg}`
    },
    customPrettifiers: {
      level: (level: any) => bg(levelLabels[level], levelColors[level]),
    },
    sync,
  }),
})
