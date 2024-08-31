import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnyProcedure } from '../lib/api.ts'
import { Scope } from '../lib/constants.ts'
import {
  Container,
  Injectable,
  asOptional,
  getInjectableScope,
} from '../lib/container.ts'
import { injectables } from '../lib/injectables.ts'
import { Provider, provide } from '../lib/providers.ts'
import { Registry } from '../lib/registry.ts'
import {
  type TestTypeProvider,
  testLogger,
  testProcedure,
  testService,
} from './_utils.ts'

describe.sequential('Injectable', () => {
  let injectable: Injectable

  beforeEach(() => {
    injectable = new Injectable()
  })

  it('should be a injectable', () => {
    expect(injectable).toBeDefined()
    expect(injectable).toBeInstanceOf(Injectable)
  })

  it('should chain with a value', () => {
    const value = () => {}
    injectable.withValue(value)
    expect(injectable.value).toBe(value)
  })

  it('should chain with a factory', () => {
    const factory = () => {}
    injectable.withFactory(factory)
    expect(injectable.factory).toBe(factory)
  })

  it('should chain with a disposal', () => {
    const dispose = () => {}
    injectable.withDispose(dispose)
    expect(injectable.dispose).toBe(dispose)
  })

  it('should chain with a scope', () => {
    injectable.withScope(Scope.Call)
    expect(injectable.scope).toBe(Scope.Call)
  })

  it('should chain with a dependencies', () => {
    const dep1 = new Injectable().withValue('dep1')
    const dep2 = new Injectable().withValue('dep2')

    injectable.withDependencies({ dep1 }).withDependencies({ dep2 })

    expect(injectable.dependencies).toHaveProperty('dep1', dep1)
    expect(injectable.dependencies).toHaveProperty('dep2', dep2)
  })
})

describe.sequential('Provider', () => {
  let provider: Provider<TestTypeProvider>

  beforeEach(() => {
    provider = new Provider<TestTypeProvider>()
  })

  it('should be a provider', () => {
    expect(provider).toBeDefined()
    expect(provider).toBeInstanceOf(Provider)
  })

  it('should chain with a factory', () => {
    const factory = () => 1 as const
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
    const dep1 = new Injectable().withValue('dep1')
    const dep2 = new Injectable().withValue('dep2')

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
    const dep = new Injectable().withValue('dep')
    const ctx = await container.createContext({ dep })
    expect(ctx).toHaveProperty('dep')
  })

  it('should be a container', () => {
    expect(container).toBeDefined()
    expect(container).instanceOf(Container)
  })

  it('should resolve with value', async () => {
    const value = {}
    const injectable = new Injectable().withValue(value)
    await expect(container.resolve(injectable)).resolves.toBe(value)
  })

  it('should resolve with factory', async () => {
    const value = {}
    const injectable = new Injectable().withFactory(() => value)
    await expect(container.resolve(injectable)).resolves.toBe(value)
  })

  it('should provide dependencies', async () => {
    const dep1 = new Injectable().withValue('dep1' as const)
    const dep2 = new Injectable()
      .withDependencies({ dep1 })
      .withFactory((deps) => deps)
    const dep3 = new Injectable().withFactory(() => 'dep3' as const)
    const injectable = new Injectable()
      .withDependencies({ dep2, dep3 })
      .withFactory((deps) => deps)
    const deps = await container.resolve(injectable)
    expect(deps).toHaveProperty('dep2', { dep1: 'dep1' })
    expect(deps).toHaveProperty('dep3', 'dep3')
  })

  it('should dispose', async () => {
    const injectable = new Injectable()
      .withFactory(() => ({}))
      .withDispose(() => {})
    const spy = vi.spyOn(injectable, 'dispose')
    await container.resolve(injectable)
    await container.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should be cached', async () => {
    const injectable = new Injectable().withFactory(() => ({}))
    const val = await container.resolve(injectable)
    expect(container.has(injectable)).toBe(true)
    expect(await container.resolve(injectable)).toBe(val)
  })

  it('should handle dispose error', async () => {
    const injectable = new Injectable()
      .withFactory(() => {})
      .withDispose(() => {
        throw new Error()
      })
    await container.resolve(injectable)
    await expect(container.dispose()).resolves.not.toThrow()
  })

  it('should handle concurrent resolutions', async () => {
    const injectable = new Injectable()
      .withFactory(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return {}
      })
      .withDispose(() => {
        throw new Error()
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

  it('should resolve scopes', async () => {
    const globalInjectable = new Injectable()
      .withScope(Scope.Global)
      .withFactory(() => ({}))

    const connectionInjectable = new Injectable()
      .withScope(Scope.Connection)
      .withDependencies({
        globalValue: globalInjectable,
      })
      .withFactory(({ globalValue }) => {
        return { globalValue }
      })

    const callInjectable = new Injectable()
      .withScope(Scope.Connection)
      .withDependencies({
        connectionValue: connectionInjectable,
        globalValue: globalInjectable,
      })
      .withFactory(({ globalValue, connectionValue }) => {
        return { globalValue, connectionValue }
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

  it('should correctly resolve injectable scope', async () => {
    const injectable = new Injectable().withScope(Scope.Connection)
    const injectable2 = new Injectable().withScope(Scope.Call)
    const injectable3 = new Injectable().withDependencies({
      injectable,
      injectable2,
    })
    expect(getInjectableScope(injectable3)).toBe(Scope.Call)
  })

  it('should preload global dependencies', async () => {
    const factory1 = vi.fn(() => ({}))
    const injectable1 = new Injectable()
      .withScope(Scope.Global)
      .withFactory(factory1)
    const factory2 = vi.fn(() => ({}))
    const injectable2 = new Injectable()
      .withScope(Scope.Connection)
      .withFactory(factory2)
    const procedure = testProcedure().withDependencies({
      injectable1,
      injectable2,
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
    const injectable1 = new Injectable()
      .withFactory(() => '1')
      .withDispose(disposeSpy)
    const injectable2 = new Injectable()
      .withDependencies({ injectable1 })
      .withFactory(() => '2')
      .withDispose(disposeSpy)
    const injectable3 = new Injectable()
      .withDependencies({ injectable1, injectable2 })
      .withFactory(() => '3')
      .withDispose(disposeSpy)
    const injectable4 = new Injectable()
      .withDependencies({ injectable1, injectable3 })
      .withFactory(() => '4')
      .withDispose(disposeSpy)
    const injectable5 = new Injectable()
      .withDependencies({ injectable2, injectable4 })
      .withFactory(() => '5')
      .withDispose(disposeSpy)

    await container.resolve(injectable5)
    await container.dispose()

    expect(order).toStrictEqual(['5', '4', '3', '2', '1'])
  })

  it('should fail to resolve required dependency', async () => {
    const injectable = new Injectable().withDependencies({
      dep: injectables.callSignal,
    })
    await expect(container.resolve(injectable)).rejects.toThrow(
      'Missing dependency',
    )
  })

  it('should resolve optional dependency', async () => {
    const injectable = new Injectable().withDependencies({
      dep: asOptional(injectables.callSignal),
    })
    await expect(container.resolve(injectable)).rejects.toThrow()
  })

  it('should be able to inject a provider', async () => {
    const options = new Injectable().withValue('string' as const)
    const provider = new Provider<TestTypeProvider>().withFactory(
      ({ options }) => options,
    )
    const provided = provide(provider, options)
    const injectable = new Injectable()
      .withDependencies({
        provider: provided,
      })
      .withFactory(({ provider }) => provider)

    await expect(container.resolve(injectable)).resolves.toBe('string')
  })
})
