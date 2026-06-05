import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'
import { createLogger, forkLogger } from '@nmtjs/core'

import type {
  NeemLoggerInput,
  NeemLoggerOptions,
  NeemMode,
} from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'
import { importDefault } from './utils.ts'

export function childLogger(logger: Logger, label: string): Logger {
  return forkLogger(logger, label)
}

export function createLoggerFromConfigInput(
  mode: NeemMode,
  input: NeemLoggerInput | undefined,
): Logger {
  if (!input || typeof input === 'string' || input instanceof URL) {
    return createDefaultLogger(mode)
  }

  return createDefaultLogger(mode, input)
}

export async function resolveManifestLogger(
  logger: ManifestLogger | undefined,
  options: { mode: NeemMode; outDir: string },
): Promise<Logger> {
  if (!logger) return createDefaultLogger(options.mode)
  if (logger.type === 'options') {
    return createDefaultLogger(options.mode, logger.options)
  }

  return importDefault<Logger>(resolve(options.outDir, logger.file))
}

export function runtimeLabel(runtimeName: string, threadName?: string): string {
  if (!threadName) return `runtime:${runtimeName}`
  const prefix = `${runtimeName}:`
  const normalized = threadName.startsWith(prefix)
    ? threadName.slice(prefix.length)
    : threadName
  return `runtime:${runtimeName}:${normalized}`
}

export function createDefaultLogger(
  mode: NeemMode = 'production',
  input: NeemLoggerOptions = {},
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
