import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { NeemConfig, NeemLoggerInput } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode } = {},
): Promise<Logger> {
  if (!input) return createNeemDefaultLogger(options.mode)
  if (typeof input === 'function') return (await input()).default
  return input
}

export function resolveNeemInlineLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode } = {},
): Logger {
  if (!input || typeof input === 'function') {
    return createNeemDefaultLogger(options.mode)
  }
  return input
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

export function createNeemDefaultLogger(mode: NeemMode = 'production'): Logger {
  if (process.env.NODE_ENV === 'test') {
    return createLogger({ pinoOptions: { enabled: false } }, 'Neem')
  }

  return createLogger(
    { pinoOptions: { level: mode === 'development' ? 'debug' : 'info' } },
    'Neem',
  )
}
