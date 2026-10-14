import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import * as Cause from 'effect/Cause'
import * as Formatter from 'effect/Formatter'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'

const levels = {
  Fatal: 'fatal',
  Error: 'error',
  Warn: 'warn',
  Info: 'info',
  Debug: 'debug',
  Trace: 'trace',
} as const

/**
 * Effect's logs through the worker's logger, which Neem flushes when the
 * thread stops: what the engine reports, and what handlers log. Annotations
 * become fields, and a cause the `err` the logger serializes.
 */
export const logging = (logger: NeemRuntimeWorkerContext['logger']) =>
  Logger.layer([
    Logger.make<unknown, void>(({ cause, fiber, logLevel, message }) => {
      // `All` and `None` are thresholds, never the level of an entry.
      if (logLevel === 'All' || logLevel === 'None') return
      const parts = Array.isArray(message) ? message : [message]
      logger[levels[logLevel]](
        {
          ...fiber.getRef(References.CurrentLogAnnotations),
          ...(cause.reasons.length > 0 ? { err: Cause.squash(cause) } : {}),
        },
        parts
          .map((part) =>
            typeof part === 'string' ? part : Formatter.format(part),
          )
          .join(' '),
      )
    }),
  ])
