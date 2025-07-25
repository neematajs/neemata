import { threadId } from 'node:worker_threads'
import {
  type DestinationStream,
  type Level,
  type Logger as PinoLogger,
  pino,
  type StreamEntry,
  stdTimeFunctions,
} from 'pino'
import { build as pretty } from 'pino-pretty'

export type { StreamEntry } from 'pino'
export type Logger = PinoLogger
export type LoggingOptions = {
  destinations?: Array<DestinationStream | StreamEntry<Level>>
  pinoOptions?: any
}

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

export const createLogger = (options: LoggingOptions = {}, $group: string) => {
  let { destinations, pinoOptions } = options

  if (!destinations || !destinations?.length) {
    destinations = [createConsolePrettyDestination('info')]
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
  return pino(
    {
      timestamp: stdTimeFunctions.isoTime,
      ...pinoOptions,
      level,
    },
    pino.multistream(destinations!),
  ).child({ $group, $threadId: threadId })
}

export const createConsolePrettyDestination = (
  level: Level,
  sync = true,
): StreamEntry => ({
  level,
  stream: pretty({
    colorize: true,
    ignore: 'hostname,$group,$threadId',
    errorLikeObjectKeys: ['err', 'error', 'cause'],
    messageFormat: (log, messageKey) => {
      const group = fg(`[${log.$group}]`, 11)
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
