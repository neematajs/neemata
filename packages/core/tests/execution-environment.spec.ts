import { describe, expect, it, vi } from 'vitest'

import type { Dependant } from '../src/injectables.ts'
import { Container } from '../src/container.ts'
import { ExecutionEnvironment } from '../src/execution-environment.ts'
import {
  CoreInjectables,
  createFactoryInjectable,
  createValueInjectable,
} from '../src/injectables.ts'
import { testLogger } from './_utils.ts'

describe('ExecutionEnvironment', () => {
  it('creates a scoped container and provides the execution logger', async () => {
    const parent = new Container({ logger: testLogger() })
    const environment = new ExecutionEnvironment({
      logger: testLogger(),
      container: parent,
      label: 'TestExecution',
    })

    try {
      await environment.initialize()

      expect(environment.container).not.toBe(parent)
      expect(environment.container.get(CoreInjectables.logger)).toBe(
        environment.logger,
      )
      expect(environment.logger.bindings()).toHaveProperty(
        '$label',
        'TestExecution',
      )
    } finally {
      await environment.dispose()
      await parent.dispose()
    }
  })

  it('initializes dependencies declared by dependants', async () => {
    const dispose = vi.fn()
    const value = createValueInjectable('value')
    const dependency = createFactoryInjectable({
      dependencies: { value },
      create: ({ value }) => ({ value }),
      dispose,
    })
    const dependant: Dependant = { dependencies: { dependency } }
    const environment = new ExecutionEnvironment({ logger: testLogger() })

    try {
      await environment.initialize([dependant])

      await expect(
        environment.container.createContext(dependant.dependencies),
      ).resolves.toEqual({ dependency: { value: 'value' } })
    } finally {
      await environment.dispose()
    }

    expect(dispose).toHaveBeenCalledOnce()
  })
})
