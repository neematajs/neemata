import { pathToFileURL } from 'node:url'

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
    const specifier =
      typeof input === 'string' && options.importer
        ? await resolveLoggerSpecifier(options.importer, input)
        : input.toString()
    return (await import(specifier)).default as Logger
  }
  return createNeemDefaultLogger(options.mode, input)
}

async function resolveLoggerSpecifier(
  importer: string,
  specifier: string,
): Promise<string> {
  const { resolveImportFile } = await import('../build/resolve.ts')
  return pathToFileURL(resolveImportFile(importer, specifier)).href
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

export function createNeemDefaultLogger(
  mode: NeemMode = 'production',
  input: Exclude<NeemLoggerInput, string | URL> = {},
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
