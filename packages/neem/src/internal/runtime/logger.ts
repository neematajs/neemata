import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { NeemConfig, NeemLoggerInput } from '../../public/config.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
): Promise<Logger> {
  if (!input) return createLogger({}, 'Neem')
  if (typeof input === 'function') return (await input()).default
  return input
}

export function resolveNeemInlineLogger(
  input: NeemLoggerInput | undefined,
): Logger {
  if (!input || typeof input === 'function') return createLogger({}, 'Neem')
  return input
}

export async function resolveNeemConfigLogger(
  config: NeemConfig,
): Promise<Logger> {
  return await resolveNeemLogger(config.logger)
}

export function createNeemChildLogger(logger: Logger, label: string): Logger {
  return logger.child({ $label: label })
}
