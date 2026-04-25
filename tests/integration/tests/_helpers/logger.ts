import type { LoggingOptions } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

export function createTestLogger(
  options: LoggingOptions = { pinoOptions: { enabled: false } },
  label = 'test',
) {
  return createLogger(options, label)
}
