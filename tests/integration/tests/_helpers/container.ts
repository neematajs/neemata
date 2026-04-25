import { Container } from '@nmtjs/core'

import { createTestLogger } from './logger.ts'

export function createTestContainer(
  options: ConstructorParameters<typeof Container>[0] = {
    logger: createTestLogger(),
  },
) {
  return new Container(options)
}
