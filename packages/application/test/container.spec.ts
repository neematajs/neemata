import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnyProcedure } from '../lib/api.ts'
import { Scope } from '../lib/constants.ts'
import {
  Container,
  Provider,
  asOptional,
  getProviderScope,
} from '../lib/container.ts'
import { providers } from '../lib/providers.ts'
import { Registry } from '../lib/registry.ts'
import { testLogger, testProcedure, testService } from './_utils.ts'

describe.sequential('Provider', () => {
  let provider: Provider

  beforeEach(() => {
    provider = new Provider()
  })

  it('should be a provider', () => {
    expect(provider).toBeDefined()
    expect(provider).toBeInstanceOf(Provider)
  })

  it('should chain with a value', () => {
    const value = () => {}
    provider.withValue(value)
    expect(provider.value).toBe(value)
  })

  it('should chain with a factory', () => {
    const factory = () => {}
    provider.withFactory(factory)
    expect(provider.factory).toBe(factory)
  })

  it('should chain with a disposal', () => {
    const dispose = () => {}
    provider.withDispose(dispose)
    expect(provider.dispose).toBe(dispose)
  })

  it('should chain with a scope', () => {
    provider.withScope(Scope.Call)
    expect(provider.scope).toBe(Scope.Call)
  })

  it('should chain with a dependencies', () => {
    const dep1 = new Provider().withValue('dep1')
    const dep2 = new Provider().withValue('dep2')

    provider.withDependencies({ dep1 }).withDependencies({ dep2 })

    expect(provider.dependencies).toHaveProperty('dep1', dep1)
    expect(provider.dependencies).toHaveProperty('dep2', dep2)
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
    const dep = new Provider().withValue('dep')
    const ctx = await container.createContext({ dep })
    expect(ctx).toHaveProperty('dep')
  })

  it('should be a container', () => {
    expect(container).toBeDefined()
    expect(container).instanceOf(Container)
  })

  it('should resolve with value', async () => {
    const value = {}
    const provider = new Provider().withValue(value)
    await expect(container.resolve(provider)).resolves.toBe(value)
  })

  it('should resolve with factory', async () => {
    const value = {}
    const provider = new Provider().withFactory(() => value)
    await expect(container.resolve(provider)).resolves.toBe(value)
  })

  it('should provide dependencies', async () => {
    const dep1 = new Provider().withValue('dep1' as const)
    const dep2 = new Provider()
      .withDependencies({ dep1 })
      .withFactory((deps) => deps)
    const dep3 = new Provider().withFactory(() => 'dep3' as const)
    const provider = new Provider()
      .withDependencies({ dep2, dep3 })
      .withFactory((deps) => deps)
    const deps = await container.resolve(provider)
    expect(deps).toHaveProperty('dep2', { dep1: 'dep1' })
    expect(deps).toHaveProperty('dep3', 'dep3')
  })

  it('should dispose', async () => {
    const provider = new Provider()
      .withFactory(() => ({}))
      .withDispose(() => {})
    const spy = vi.spyOn(provider, 'dispose')
    await container.resolve(provider)
    await container.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should be cached', async () => {
    const provider = new Provider().withFactory(() => ({}))
    const val = await container.resolve(provider)
    expect(container.has(provider)).toBe(true)
    expect(await container.resolve(provider)).toBe(val)
  })

  it('should handle dispose error', async () => {
    const provider = new Provider()
      .withFactory(() => {})
      .withDispose(() => {
        throw new Error()
      })
    await container.resolve(provider)
    await expect(container.dispose()).resolves.not.toThrow()
  })

  it('should handle concurrent resolutions', async () => {
    const provider = new Provider()
      .withFactory(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return {}
      })
      .withDispose(() => {
        throw new Error()
      })
    const res1 = container.resolve(provider)
    const res2 = container.resolve(provider)
    expect(res1).toBe(res2)
  })

  it('should create scoped container', async () => {
    const scopeContainer = container.createScope(Scope.Call)
    expect(scopeContainer).toBeInstanceOf(Container)
    expect(scopeContainer).not.toBe(container)
    expect(scopeContainer).toHaveProperty('parent')
  })

  it('should resolve scopes', async () => {
    const globalProvider = new Provider()
      .withScope(Scope.Global)
      .withFactory(() => ({}))

    const connectionProvider = new Provider()
      .withScope(Scope.Connection)
      .withDependencies({
        globalValue: globalProvider,
      })
      .withFactory(({ globalValue }) => {
        return { globalValue }
      })

    const callProvider = new Provider()
      .withScope(Scope.Connection)
      .withDependencies({
        connectionValue: connectionProvider,
        globalValue: globalProvider,
      })
      .withFactory(({ globalValue, connectionValue }) => {
        return { globalValue, connectionValue }
      })

    const globalProviderValue = await container.resolve(globalProvider)
    const scopeContainer = container.createScope(Scope.Call)

    const callProviderValue = await scopeContainer.resolve(callProvider)

    expect(scopeContainer.instances.has(globalProvider)).toBe(false)
    expect(scopeContainer.instances.has(connectionProvider)).toBe(true)
    expect(callProviderValue.globalValue).toBe(globalProviderValue)

    const connectionProviderValue =
      await scopeContainer.resolve(connectionProvider)
    expect(callProviderValue.globalValue).toBe(
      connectionProviderValue.globalValue,
    )
    expect(scopeContainer.has(globalProvider)).toBe(true)
  })

  it('should correctly resolve provider scope', async () => {
    const provider = new Provider().withScope(Scope.Connection)
    const provider2 = new Provider().withScope(Scope.Call)
    const provider3 = new Provider().withDependencies({ provider, provider2 })
    expect(getProviderScope(provider3)).toBe(Scope.Call)
  })

  it('should preload global dependencies', async () => {
    const factory1 = vi.fn(() => ({}))
    const provider1 = new Provider()
      .withScope(Scope.Global)
      .withFactory(factory1)
    const factory2 = vi.fn(() => ({}))
    const provider2 = new Provider()
      .withScope(Scope.Connection)
      .withFactory(factory2)
    const procedure = testProcedure().withDependencies({
      provider1,
      provider2,
    }) satisfies AnyProcedure
    const service = testService({ procedure })
    registry.registerService(service)
    await container.load()
    expect(factory1).toHaveBeenCalledOnce()
    expect(factory2).not.toHaveBeenCalled()
  })

  it('should dispose in correct order', async () => {
    const disposeSpy = vi.fn((value) => order.push(value))
    const order: string[] = []
    const provider1 = new Provider()
      .withFactory(() => '1')
      .withDispose(disposeSpy)
    const provider2 = new Provider()
      .withDependencies({ provider1 })
      .withFactory(() => '2')
      .withDispose(disposeSpy)
    const provider3 = new Provider()
      .withDependencies({ provider1, provider2 })
      .withFactory(() => '3')
      .withDispose(disposeSpy)
    const provider4 = new Provider()
      .withDependencies({ provider1, provider3 })
      .withFactory(() => '4')
      .withDispose(disposeSpy)
    const provider5 = new Provider()
      .withDependencies({ provider2, provider4 })
      .withFactory(() => '5')
      .withDispose(disposeSpy)

    await container.resolve(provider5)
    await container.dispose()

    expect(order).toStrictEqual(['5', '4', '3', '2', '1'])
  })

  it('should fail to resolve required dependency', async () => {
    const provider = new Provider().withDependencies({
      dep: providers.callSignal,
    })
    await expect(container.resolve(provider)).rejects.toThrow(
      'Missing dependency',
    )
  })

  it('should resolve optional dependency', async () => {
    const provider = new Provider().withDependencies({
      dep: asOptional(providers.callSignal),
    })
    await expect(container.resolve(provider)).rejects.toThrow()
  })
})
