import { Container } from '@nmtjs/core'

import { createTestLogger } from './logger.ts'

/**
 * Create a test container with a silent logger.
 * Useful for unit tests that need DI container functionality.
 */
export function createTestContainer(
  options: ConstructorParameters<typeof Container>[0] = {
    logger: createTestLogger(),
  },
) {
  return new Container(options)
}
