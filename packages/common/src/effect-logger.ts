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
// these names goes under `annotations` instead of overwriting it. Pino also
// fails on a top-level `__proto__` field, looking it up among its serializers.
const reserved = new Set([
  '__proto__',
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
  // Runs for every entry, so it avoids intermediate arrays and closures and
  // allocates only what the record keeps.
  return Logger.make(({ message, logLevel, cause, fiber, date }) => {
    const level = levels[logLevel]
    if (level === undefined || !logger.isLevelEnabled(level)) return

    const record: Record<string, unknown> = {}
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    let clashing: Record<string, unknown> | undefined
    for (const key in annotations) {
      if (!Object.hasOwn(annotations, key)) continue
      if (reserved.has(key)) assign((clashing ??= {}), key, annotations[key])
      else record[key] = annotations[key]
    }
    if (clashing !== undefined) record.annotations = clashing
    const spans = fiber.getRef(References.CurrentLogSpans)
    if (spans.length > 0) {
      const now = date.getTime()
      const elapsed: Record<string, number> = {}
      for (let i = 0; i < spans.length; i++)
        assign(elapsed, spans[i][0], now - spans[i][1])
      record.spans = elapsed
    }
    record.fiberId = fiber.id

    let errors = causeErrors(cause)
    let msg: string | undefined
    let values: unknown[] | undefined
    // Effect.log always passes an array; only a direct caller passes one value.
    const parts: ReadonlyArray<unknown> = Array.isArray(message)
      ? message
      : [message]
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (typeof part === 'string')
        msg = msg === undefined ? part : `${msg} ${part}`
      // Pino serializes an Error's message and stack only under `err`.
      else if (part instanceof Error) (errors ??= []).push(part)
      else (values ??= []).push(part)
    }
    if (values !== undefined)
      record.message = values.length === 1 ? values[0] : values
    if (errors !== undefined)
      record.err =
        errors.length === 1
          ? errors[0]
          : new AggregateError(errors, `${errors.length} errors`)

    // Values stay structured only: a formatted copy in msg would escape Pino's
    // path-based redaction.
    if (msg === undefined) logger[level](record)
    else logger[level](record, msg)
  })
}

/**
 * Replaces Effect's default console logger with one writing to `logger`.
 * Effect's tracer logger stays, so logs still become events on the current span.
 */
export function pinoLoggerLayer(logger: PinoLogger): Layer.Layer<never> {
  return Logger.layer([makePinoLogger(logger), Logger.tracerLogger])
}

// Annotation keys and span labels come from the application; plain assignment
// of `__proto__` would replace the object's prototype instead of adding a field.
function assign(target: Record<string, unknown>, key: string, value: unknown) {
  if (key === '__proto__')
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  else target[key] = value
}

function causeErrors(cause: Cause.Cause<unknown>): unknown[] | undefined {
  // An interruption is how supervised work stops, not a failure to report.
  // Failures keep their identity, so serializers and redaction see their own
  // fields; rendering would copy those fields into message text.
  let errors: unknown[] | undefined
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) (errors ??= []).push(reason.error)
    else if (Cause.isDieReason(reason)) (errors ??= []).push(reason.defect)
  }
  return errors
}
