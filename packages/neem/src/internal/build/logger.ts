import { pathToFileURL } from 'node:url'

import type { Logger } from '@nmtjs/core'

import type { NeemLoggerInput } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import { resolveNeemLogger as resolveRuntimeNeemLogger } from '../runtime/logger.ts'
import { resolveImportFile } from './resolve.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode; importer?: string } = {},
): Promise<Logger> {
  const loggerInput =
    typeof input === 'string' && options.importer
      ? pathToFileURL(resolveImportFile(options.importer, input))
      : input
  return resolveRuntimeNeemLogger(loggerInput, { mode: options.mode })
}
