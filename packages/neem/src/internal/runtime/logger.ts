import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { NeemLoggerInput, NeemLoggerOptions } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import { importDefault } from './utils.ts'

export async function resolveNeemLogger(
  input: NeemLoggerInput | undefined,
  options: { mode?: NeemMode } = {},
): Promise<Logger> {
  if (!input) return createNeemDefaultLogger(options.mode)
  if (typeof input === 'string' || input instanceof URL) {
    return importDefault<Logger>(input)
  }
  return createNeemDefaultLogger(options.mode, input)
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
