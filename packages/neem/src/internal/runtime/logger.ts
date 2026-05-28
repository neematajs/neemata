import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { NeemConfig, NeemLoggerInput } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode; importer?: string } = {},
): Promise<Logger> {
  if (!input) return createNeemDefaultLogger(options.mode)
  if (typeof input === 'string' || input instanceof URL) {
    const specifier = input.toString()
    return (await import(specifier)).default as Logger
  }
  return createNeemDefaultLogger(options.mode, input)
}

export function resolveNeemInlineLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode } = {},
): Logger {
  if (!input || typeof input === 'string') {
    return createNeemDefaultLogger(options.mode)
  }
  if (input instanceof URL) return createNeemDefaultLogger(options.mode)
  return createNeemDefaultLogger(options.mode, input)
}

export async function resolveNeemConfigLogger(
  config: NeemConfig,
  options: { mode?: NeemMode; importer?: string } = {},
): Promise<Logger> {
  return await resolveNeemLogger(config.logger, options)
}

export function createNeemChildLogger(logger: Logger, label: string): Logger {
  return logger.child({ $label: label })
}

export function createNeemRuntimeLabel(
  runtimeName: string,
  threadName?: string,
): string {
  if (!threadName) return `runtime:${runtimeName}`

  const runtimePrefix = `${runtimeName}:`
  const normalizedThreadName = threadName.startsWith(runtimePrefix)
    ? threadName.slice(runtimePrefix.length)
    : threadName
  return `runtime:${runtimeName}:${normalizedThreadName}`
}

export function createNeemDefaultLogger(
  mode: NeemMode = 'production',
  input: Exclude<NeemLoggerInput, string | URL> = {},
): Logger {
  if (process.env.NODE_ENV === 'test') {
    return createLogger({ pinoOptions: { enabled: false } }, 'neem')
  }

  return createLogger(
    {
      ...input,
      pinoOptions: {
        level: mode === 'development' ? 'debug' : 'info',
        ...input.pinoOptions,
      },
    },
    'neem',
  )
}
