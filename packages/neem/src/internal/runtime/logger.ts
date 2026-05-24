import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { NeemConfig, NeemLoggerInput } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode } = {},
): Promise<Logger> {
  if (!input) return createNeemDefaultLogger(options.mode)
  if (typeof input === 'string' || input instanceof URL) {
    return (await import(input.toString())).default as Logger
  }
  if (typeof input === 'function') return (await input()).default
  if (isLogger(input)) return input
  return createNeemDefaultLogger(options.mode, input)
}

export function resolveNeemInlineLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode } = {},
): Logger {
  if (!input || typeof input === 'function' || typeof input === 'string') {
    return createNeemDefaultLogger(options.mode)
  }
  if (input instanceof URL) return createNeemDefaultLogger(options.mode)
  if (isLogger(input)) return input
  return createNeemDefaultLogger(options.mode, input)
}

export async function resolveNeemConfigLogger(
  config: NeemConfig,
  options: { mode?: NeemMode } = {},
): Promise<Logger> {
  return await resolveNeemLogger(config.logger, options)
}

export function createNeemChildLogger(logger: Logger, label: string): Logger {
  return logger.child({ $label: label })
}

export function createNeemDefaultLogger(
  mode: NeemMode = 'production',
  input: Exclude<NeemLoggerInput, Logger | Function | string | URL> = {},
): Logger {
  if (process.env.NODE_ENV === 'test') {
    return createLogger({ pinoOptions: { enabled: false } }, 'Neem')
  }

  return createLogger(
    {
      ...input,
      pinoOptions: {
        level: mode === 'development' ? 'debug' : 'info',
        ...input.pinoOptions,
      },
    },
    'Neem',
  )
}

function isLogger(input: NeemLoggerInput): input is Logger {
  return (
    typeof input === 'object' &&
    input !== null &&
    'child' in input &&
    typeof input.child === 'function' &&
    'info' in input &&
    typeof input.info === 'function'
  )
}
