import type { LoggingOptions } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

/**
 * Create a silent test logger with logging disabled.
 * Useful for unit tests where log output is not needed.
 */
export function createTestLogger(
  options: LoggingOptions = { pinoOptions: { enabled: false } },
  label = 'test',
) {
  return createLogger(options, label)
}
