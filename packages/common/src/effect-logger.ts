import type * as Layer from 'effect/Layer'
import type * as LogLevel from 'effect/LogLevel'
import * as Cause from 'effect/Cause'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'

type PinoLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

/**
 * The part of a Pino logger the adapter uses, so this package needs no Pino
 * dependency; Neem's `ctx.logger` and any `pino()` instance satisfy it.
 */
export type PinoLogger = {
  isLevelEnabled(level: string): boolean
} & Record<PinoLevel, (record: object, msg?: string) => void>

// "All" and "None" are thresholds for MinimumLogLevel, never entry levels.
const levels: Record<LogLevel.LogLevel, PinoLevel | undefined> = {
  All: undefined,
  Fatal: 'fatal',
  Error: 'error',
  Warn: 'warn',
  Info: 'info',
  Debug: 'debug',
  Trace: 'trace',
  None: undefined,
}

// Fields Pino writes itself or this adapter owns. An annotation with one of
// these names goes under `annotations` instead of overwriting it.
const reserved = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'err',
  'message',
  'spans',
  'fiberId',
  'annotations',
])

/**
 * An Effect logger that writes each entry to `logger` as one structured Pino
 * record. Effect's MinimumLogLevel filters first; Pino's level filters after.
 */
export function makePinoLogger(
  logger: PinoLogger,
): Logger.Logger<unknown, void> {
  return Logger.make(({ message, logLevel, cause, fiber, date }) => {
    const level = levels[logLevel]
    if (level === undefined || !logger.isLevelEnabled(level)) return

    const record: Record<string, unknown> = {}
    let clashing: Record<string, unknown> | undefined
    for (const [key, value] of Object.entries(
      fiber.getRef(References.CurrentLogAnnotations),
    )) {
      if (reserved.has(key)) (clashing ??= {})[key] = value
      else record[key] = value
    }
    if (clashing) record.annotations = clashing
    const spans = fiber.getRef(References.CurrentLogSpans)
    if (spans.length > 0) {
      const now = date.getTime()
      record.spans = Object.fromEntries(
        spans.map(([label, start]) => [label, now - start]),
      )
    }
    record.fiberId = `#${fiber.id}`

    const errors = causeErrors(cause)
    const text: string[] = []
    const values: unknown[] = []
    for (const part of Array.isArray(message) ? message : [message]) {
      if (typeof part === 'string') text.push(part)
      // Pino serializes an Error's message and stack only under `err`.
      else if (part instanceof Error) errors.push(part)
      else values.push(part)
    }
    if (values.length > 0)
      record.message = values.length === 1 ? values[0] : values
    if (errors.length > 0)
      record.err =
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, `${errors.length} errors`)

    // Values stay structured only: a formatted copy in msg would escape Pino's
    // path-based redaction.
    if (text.length > 0) logger[level](record, text.join(' '))
    else logger[level](record)
  })
}

/** Replaces the default Effect loggers with one writing to `logger`. */
export function pinoLoggerLayer(logger: PinoLogger): Layer.Layer<never> {
  return Logger.layer([makePinoLogger(logger)])
}

function causeErrors(cause: Cause.Cause<unknown>): unknown[] {
  // An interruption is how supervised work stops, not a failure to report.
  // Failures keep their identity, so serializers and redaction see their own
  // fields; rendering would copy those fields into message text.
  return cause.reasons.flatMap((reason) =>
    Cause.isInterruptReason(reason)
      ? []
      : [Cause.isFailReason(reason) ? reason.error : reason.defect],
  )
}
