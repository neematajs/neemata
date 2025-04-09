import { beforeEach, describe, expect, it } from 'vitest'

import type { Logger } from '../src/logger.ts'
import { Registry } from '../src/registry.ts'
import { testLogger } from './_utils.ts'

describe('Registry', () => {
  let registry: Registry
  let logger: Logger

  beforeEach(() => {
    logger = testLogger()
    registry = new Registry({ logger })
  })

  it('should be a registry', () => {
    expect(registry).toBeDefined()
    expect(registry).toBeInstanceOf(Registry)
  })
})
