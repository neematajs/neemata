import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { injectables } from '../lib/common.ts'
import {
  FactoryInjectableKey,
  InjectableKey,
  LazyInjectableKey,
  Scope,
  ValueInjectableKey,
} from '../lib/constants.ts'
import {
  Container,
  asOptional,
  createFactoryInjectable,
  createLazyInjectable,
  createValueInjectable,
  getInjectableScope,
} from '../lib/container.ts'
import { provide, withTypeProvider } from '../lib/provider.ts'
import { Registry } from '../lib/registry.ts'
import { noop } from '../lib/utils/functions.ts'
import {
  type TestTypeProvider,
  testLogger,
  testProcedure,
  testService,
} from './_utils.ts'

describe.sequential('Injectable', () => {
  it('should create a lazy injectable', () => {
    const injectable = createLazyInjectable()
    expect(injectable.dependencies).toStrictEqual({})
    expect(injectable.scope).toBe(Scope.Global)
    expect(InjectableKey in injectable).toBe(true)
    expect(LazyInjectableKey in injectable).toBe(true)
  })

  it('should create a lazy injectable with a scope', () => {
    const injectable = createLazyInjectable(Scope.Call)
    expect(injectable.scope).toBe(Scope.Call)
  })

  it('should create a value injectable', () => {
    const value = {}
    const injectable = createValueInjectable(value)
    expect(injectable.value).toBe(value)
    expect(injectable.dependencies).toStrictEqual({})
    expect(injectable.scope).toBe(Scope.Global)
    expect(InjectableKey in injectable).toBe(true)
    expect(ValueInjectableKey in injectable).toBe(true)
  })

  it('should create a factory injectable', () => {
    const injectable = createFactoryInjectable({ factory: noop })
    expect(injectable.factory).toBe(noop)
    expect(injectable.dependencies).toStrictEqual({})
    expect(injectable.scope).toBe(Scope.Global)
    expect(InjectableKey in injectable).toBe(true)
    expect(FactoryInjectableKey in injectable).toBe(true)
  })

  it('should create a factory injectable with scope', () => {
    const injectable = createFactoryInjectable({
      factory: noop,
      scope: Scope.Call,
    })
    expect(injectable.scope).toBe(Scope.Call)
  })

  it('should create a factory injectable with dependencies', () => {
    const dep1 = createLazyInjectable()
    const dep2 = createLazyInjectable()
    const injectable = createFactoryInjectable({
      factory: noop,
      dependencies: { dep1, dep2 },
    })
    expect(injectable.dependencies).toHaveProperty('dep1', dep1)
    expect(injectable.dependencies).toHaveProperty('dep2', dep2)
  })
})

describe.sequential('Provider', () => {
  const factory = () => 1 as const

  it('should create a provider', () => {
    const provider = withTypeProvider<TestTypeProvider>().createProvider({
      factory,
    })
    expect(LazyInjectableKey in provider.options).toBe(true)
    expect(provider.factory).toBe(factory)
    expect(provider.dependencies).toStrictEqual({ options: provider.options })
    expect(provider.scope).toBe(Scope.Global)
    expect(provider.dispose).toBeUndefined()
  })

  it('should create a provider with dispose', () => {
    const dispose = () => {}
    const provider = withTypeProvider<TestTypeProvider>().createProvider({
      factory,
      dispose,
    })
    expect(provider.dispose).toBe(dispose)
  })

  it('should create a provider with scope', () => {
    const provider = withTypeProvider<TestTypeProvider>().createProvider({
      factory,
      scope: Scope.Call,
    })
    expect(provider.scope).toBe(Scope.Call)
  })

  it('should create a provider with dependencies', () => {
    const dep1 = createLazyInjectable()
    const dep2 = createLazyInjectable()
    const provider = withTypeProvider<TestTypeProvider>().createProvider({
      factory,
      dependencies: { dep1, dep2 },
    })
    expect(provider.dependencies).toHaveProperty('options', provider.options)
    expect(provider.dependencies).toHaveProperty('dep1', dep1)
    expect(provider.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should fail to create a provider with "options" dependency', () => {
    const dep1 = createLazyInjectable()
    expect(() =>
      withTypeProvider<TestTypeProvider>().createProvider({
        factory,
        dependencies: { options: dep1 },
      }),
    ).toThrow('"options" is a reserved key for a provider dependencies')
  })
})

describe.sequential('Container', () => {
  const logger = testLogger()
  const registry = new Registry({ logger })
  let container: Container

  beforeEach(async () => {
    container = new Container({ registry, logger })
    await container.load()
  })

  afterEach(async () => {
    await container.dispose()
  })

  it('should create context', async () => {
    const dep = createValueInjectable('dep')
    const ctx = await container.createContext({ dep })
    expect(ctx).toHaveProperty('dep')
  })

  it('should be a container', () => {
    expect(container).toBeDefined()
    expect(container).instanceOf(Container)
  })

  it('should resolve with value', async () => {
    const value = {}
    const injectable = createValueInjectable(value)
    await expect(container.resolve(injectable)).resolves.toBe(value)
  })

  it('should resolve with factory', async () => {
    const value = {}
    const injectable = createFactoryInjectable(() => value)
    await expect(container.resolve(injectable)).resolves.toBe(value)
  })

  it('should resolve dependencies', async () => {
    const dep1 = createValueInjectable('dep1' as const)
    const dep2 = createFactoryInjectable({
      dependencies: { dep1 },
      factory: (deps) => deps,
    })
    const dep3 = createFactoryInjectable(() => 'dep3' as const)
    const injectable = createFactoryInjectable({
      dependencies: { dep2, dep3 },
      factory: (deps) => deps,
    })
    const deps = await container.resolve(injectable)
    expect(deps).toHaveProperty('dep2', { dep1: 'dep1' })
    expect(deps).toHaveProperty('dep3', 'dep3')
  })

  it('should dispose', async () => {
    const spy = vi.fn()
    const injectable = createFactoryInjectable({
      factory: () => ({}),
      dispose: spy,
    })
    await container.resolve(injectable)
    await container.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should be cached', async () => {
    const injectable = createFactoryInjectable(() => ({}))
    const val = await container.resolve(injectable)
    expect(container.has(injectable)).toBe(true)
    expect(await container.resolve(injectable)).toBe(val)
  })

  it('should handle dispose error', async () => {
    const injectable = createFactoryInjectable({
      factory: () => ({}),
      dispose: () => {
        throw new Error()
      },
    })
    await container.resolve(injectable)
    await expect(container.dispose()).resolves.not.toThrow()
  })

  it('should handle concurrent resolutions', async () => {
    const injectable = createFactoryInjectable({
      factory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return {}
      },
    })
    const res1 = container.resolve(injectable)
    const res2 = container.resolve(injectable)
    expect(res1).toBe(res2)
  })

  it('should create scoped container', async () => {
    const scopeContainer = container.createScope(Scope.Call)
    expect(scopeContainer).toBeInstanceOf(Container)
    expect(scopeContainer).not.toBe(container)
    expect(scopeContainer).toHaveProperty('parent')
  })

  it('should correctly resolve injectable scope', async () => {
    const injectable = createLazyInjectable(Scope.Connection)
    const injectable2 = createLazyInjectable(Scope.Call)
    const injectable3 = createFactoryInjectable({
      dependencies: { injectable, injectable2 },
      factory: noop,
    })
    expect(getInjectableScope(injectable3)).toBe(Scope.Call)
  })

  it('should resolve scopes', async () => {
    const globalInjectable = createFactoryInjectable({
      scope: Scope.Global,
      factory: () => ({}),
    })

    const connectionInjectable = createFactoryInjectable({
      dependencies: { globalValue: globalInjectable },
      scope: Scope.Connection,
      factory: (deps) => deps,
    })

    const callInjectable = createFactoryInjectable({
      dependencies: {
        globalValue: globalInjectable,
        connectionValue: connectionInjectable,
      },
      scope: Scope.Call,
      factory: ({ globalValue, connectionValue }) => {
        return { globalValue, connectionValue }
      },
    })

    const globalInjectableValue = await container.resolve(globalInjectable)
    const scopeContainer = container.createScope(Scope.Call)

    const callInjectableValue = await scopeContainer.resolve(callInjectable)

    expect(scopeContainer.instances.has(globalInjectable)).toBe(false)
    expect(scopeContainer.instances.has(connectionInjectable)).toBe(true)
    expect(callInjectableValue.globalValue).toBe(globalInjectableValue)

    const connectionInjectableValue =
      await scopeContainer.resolve(connectionInjectable)
    expect(callInjectableValue.globalValue).toBe(
      connectionInjectableValue.globalValue,
    )
    expect(scopeContainer.has(globalInjectable)).toBe(true)
  })

  it('should preload global dependencies', async () => {
    const factory1 = vi.fn(() => ({}))
    const injectable1 = createFactoryInjectable({
      scope: Scope.Global,
      factory: factory1,
    })
    const factory2 = vi.fn(() => ({}))
    const injectable2 = createFactoryInjectable({
      scope: Scope.Connection,
      factory: factory2,
    })
    const procedure = testProcedure({
      handler: noop,
      dependencies: {
        injectable1,
        injectable2,
      },
    })
    const service = testService({ procedure })
    registry.registerService(service)
    await container.load()
    expect(factory1).toHaveBeenCalledOnce()
    expect(factory2).not.toHaveBeenCalled()
  })

  it('should dispose in correct order', async () => {
    const disposeSpy = vi.fn((value) => order.push(value))
    const order: string[] = []
    const injectable1 = createFactoryInjectable({
      factory: () => '1',
      dispose: disposeSpy,
    })
    const injectable2 = createFactoryInjectable({
      dependencies: { injectable1 },
      factory: () => '2',
      dispose: disposeSpy,
    })

    const injectable3 = createFactoryInjectable({
      dependencies: { injectable1, injectable2 },
      factory: () => '3',
      dispose: disposeSpy,
    })

    const injectable4 = createFactoryInjectable({
      dependencies: { injectable1, injectable3 },
      factory: () => '4',
      dispose: disposeSpy,
    })

    const injectable5 = createFactoryInjectable({
      dependencies: { injectable2, injectable4 },
      factory: () => '5',
      dispose: disposeSpy,
    })

    await container.resolve(injectable5)
    await container.dispose()

    expect(order).toStrictEqual(['5', '4', '3', '2', '1'])
  })

  it('should fail to resolve required dependency', async () => {
    const lazyInjectable = createLazyInjectable()
    const injectable = createFactoryInjectable({
      dependencies: { dep: lazyInjectable },
      factory: noop,
    })
    await expect(container.resolve(injectable)).rejects.toThrow(
      'Missing dependency',
    )
  })

  it('should resolve optional dependency', async () => {
    const injectable = createFactoryInjectable({
      dependencies: { dep: asOptional(injectables.callSignal) },
      factory: noop,
    })
    await expect(container.resolve(injectable)).rejects.toThrow()
  })

  it('should be able to inject a provider', async () => {
    const options = createValueInjectable('string' as const)
    const provider = withTypeProvider<TestTypeProvider>().createProvider({
      factory: ({ options }) => options,
    })
    const provided = provide(provider, options)
    const injectable = createFactoryInjectable({
      dependencies: { provider: provided },
      factory: ({ provider }) => provider,
    })

    await expect(container.resolve(injectable)).resolves.toBe('string')
  })
})
