import { pathToFileURL } from 'node:url'

import type { Logger } from '@nmtjs/core'

import type { NeemConfig, NeemLoggerInput } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import { createNeemDefaultLogger } from '../runtime/logger.ts'
import { resolveImportFile } from './resolve.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode; importer?: string } = {},
): Promise<Logger> {
  if (!input) return createNeemDefaultLogger(options.mode)
  if (typeof input === 'string' || input instanceof URL) {
    const specifier =
      typeof input === 'string' && options.importer
        ? pathToFileURL(resolveImportFile(options.importer, input)).href
        : input.toString()
    return (await import(specifier)).default as Logger
  }
  return createNeemDefaultLogger(options.mode, input)
}

export async function resolveNeemConfigLogger(
  config: NeemConfig,
  options: { mode?: NeemMode; importer?: string } = {},
): Promise<Logger> {
  return await resolveNeemLogger(config.logger, options)
}
