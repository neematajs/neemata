import { describe, expect, it, vi } from 'vitest'

import type { ExecutionEnvironmentLifecycleHookTypes } from '../src/execution-environment.ts'
import type { Dependant } from '../src/injectables.ts'
import { Container } from '../src/container.ts'
import {
  ExecutionEnvironment,
  ExecutionEnvironmentLifecycleHook,
} from '../src/execution-environment.ts'
import {
  CoreInjectables,
  createFactoryInjectable,
  createLazyInjectable,
  createValueInjectable,
  provision,
} from '../src/injectables.ts'
import { createPlugin } from '../src/plugin.ts'
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

  it('registers plugin provisions and lifecycle hooks', async () => {
    const initialized = vi.fn()
    const childHook = vi.fn()
    const dependency = createLazyInjectable<string>()
    interface TestLifecycleHookTypes extends ExecutionEnvironmentLifecycleHookTypes {
      'test:ready': () => any
    }
    const environment = new ExecutionEnvironment<TestLifecycleHookTypes>({
      logger: testLogger(),
      plugins: [
        createPlugin({
          name: 'test',
          provisions: [provision(dependency, 'provided')],
          hooks: {
            [ExecutionEnvironmentLifecycleHook.BeforeInitialize]: initialized,
            'test:ready': childHook,
          },
        }),
      ],
    })

    await environment.initialize([{ dependencies: { dependency } }])

    await expect(
      environment.container.createContext({ dependency }),
    ).resolves.toEqual({ dependency: 'provided' })
    await environment.lifecycleHooks.callHook(
      ExecutionEnvironmentLifecycleHook.BeforeInitialize,
      environment,
    )
    expect(initialized).toHaveBeenCalledOnce()
    await environment.lifecycleHooks.callHook('test:ready')
    expect(childHook).toHaveBeenCalledOnce()

    await environment.dispose()
    await environment.lifecycleHooks.callHook(
      ExecutionEnvironmentLifecycleHook.BeforeInitialize,
      environment,
    )
    expect(initialized).toHaveBeenCalledOnce()
    await environment.lifecycleHooks.callHook('test:ready')
    expect(childHook).toHaveBeenCalledOnce()
  })

  it('keeps the established lifecycle hook names stable', () => {
    expect(ExecutionEnvironmentLifecycleHook).toEqual({
      BeforeInitialize: 'lifecycle:beforeInitialize',
      AfterInitialize: 'lifecycle:afterInitialize',
      BeforeDispose: 'lifecycle:beforeDispose',
      AfterDispose: 'lifecycle:afterDispose',
      Stop: 'lifecycle:stop',
      Start: 'lifecycle:start',
    })
  })
})
