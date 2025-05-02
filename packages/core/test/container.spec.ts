import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noopFn } from '../../common/src/index.ts'
import {
  kClassInjectable,
  kFactoryInjectable,
  kInjectable,
  kLazyInjectable,
  kValueInjectable,
} from '../src/constants.ts'
import { Container } from '../src/container.ts'
import { Scope } from '../src/enums.ts'
import {
  CoreInjectables,
  createClassInjectable,
  createExtendableClassInjectable,
  createFactoryInjectable,
  createLazyInjectable,
  createOptionalInjectable,
  createValueInjectable,
  getInjectableScope,
  substitute,
} from '../src/injectables.ts'
import { Registry } from '../src/registry.ts'
import { testLogger } from './_utils.ts'

describe('Injectable', () => {
  it('should create a lazy injectable', () => {
    const injectable = createLazyInjectable()
    expect(injectable.dependencies).toStrictEqual({})
    expect(injectable.scope).toBe(Scope.Global)
    expect(kInjectable in injectable).toBe(true)
    expect(kLazyInjectable in injectable).toBe(true)
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
    expect(kInjectable in injectable).toBe(true)
    expect(kValueInjectable in injectable).toBe(true)
  })

  it('should create a factory injectable', () => {
    const injectable = createFactoryInjectable({ factory: noopFn })
    expect(injectable.factory).toBe(noopFn)
    expect(injectable.dependencies).toStrictEqual({})
    expect(injectable.scope).toBe(Scope.Global)
    expect(kInjectable in injectable).toBe(true)
    expect(kFactoryInjectable in injectable).toBe(true)
  })

  it('should create a factory injectable with pick', () => {
    const spy = vi.fn()
    const injectable = createFactoryInjectable({ factory: noopFn, pick: spy })
    expect(injectable.pick).toBe(spy)
    expect(injectable.factory).toBe(noopFn)
    expect(injectable.dependencies).toStrictEqual({})
    expect(injectable.scope).toBe(Scope.Global)
    expect(kInjectable in injectable).toBe(true)
    expect(kFactoryInjectable in injectable).toBe(true)
  })

  it('should create a factory injectable with scope', () => {
    const injectable = createFactoryInjectable({
      factory: noopFn,
      scope: Scope.Call,
    })
    expect(injectable.scope).toBe(Scope.Call)
  })

  it('should create a factory injectable with dependencies', () => {
    const dep1 = createLazyInjectable()
    const dep2 = createLazyInjectable()
    const injectable = createFactoryInjectable({
      factory: noopFn,
      dependencies: { dep1, dep2 },
    })
    expect(injectable.dependencies).toHaveProperty('dep1', dep1)
    expect(injectable.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should create a class injectable', () => {
    class Injectable extends createClassInjectable() {}
    expect(Injectable).toBeDefined()
    expect(Injectable.dependencies).toStrictEqual({})
    expect(Injectable.scope).toBe(Scope.Global)
    expect(kInjectable in Injectable).toBe(true)
    expect(kClassInjectable in Injectable).toBe(true)
  })

  it('should create an extendable class injectable', () => {
    class SomeClass {}
    class Injectable extends createExtendableClassInjectable(SomeClass) {}
    expect(Injectable).toBeDefined()
    expect(Injectable.dependencies).toStrictEqual({})
    expect(Injectable.scope).toBe(Scope.Global)
    expect(kInjectable in Injectable).toBe(true)
    expect(kClassInjectable in Injectable).toBe(true)
  })

  it('should create a class injectable with dependencies', () => {
    const dep1 = createLazyInjectable()
    const dep2 = createLazyInjectable()
    class injectable extends createClassInjectable({ dep1, dep2 }) {}
    expect(injectable.dependencies).toHaveProperty('dep1', dep1)
    expect(injectable.dependencies).toHaveProperty('dep2', dep2)
  })

  it('should create an extendable class injectable from another class injectable', () => {
    const dep1 = createLazyInjectable()
    const dep2 = createLazyInjectable()
    const scope = Scope.Global
    const scope2 = Scope.Connection
    class injectable extends createClassInjectable({ dep1 }, scope) {}
    class injectable2 extends createExtendableClassInjectable(
      injectable,
      { dep2 },
      scope2,
    ) {}
    expect(injectable2).toBeDefined()
    expect(injectable2.dependencies).toStrictEqual({
      dep1,
      dep2,
    })
    expect(injectable2.scope).toBe(Scope.Connection)
    expect(kInjectable in injectable2).toBe(true)
    expect(kClassInjectable in injectable2).toBe(true)
  })

  it('should fail to create an extandable class injectable', () => {
    createLazyInjectable(Scope.Connection)
    class injectable extends createClassInjectable({}, Scope.Connection) {}
    expect(() =>
      createExtendableClassInjectable(injectable, {}, Scope.Global),
    ).toThrow('Invalid scope for injectable')
  })

  it('should substitue dependencies', () => {
    const originalValue = 'original'
    const substitutedValue = 'substituted'

    const dep1 = createValueInjectable(originalValue)

    const inj1 = createFactoryInjectable({
      dependencies: { dep1 },
      factory: () => {},
    })

    const inj2 = createFactoryInjectable({
      dependencies: { dep2: inj1 },
      factory: () => {},
    })

    class inj3 extends createClassInjectable({ inj1, inj2 }) {}

    const inj4 = substitute(inj3, {
      inj1: { dep1: createValueInjectable(substitutedValue) },
      inj2: { dep2: { dep1: createValueInjectable(substitutedValue) } },
    })

    expect(inj4).not.toBe(inj3)

    expect(inj4.dependencies.inj1.dependencies.dep1.value).toBe(
      substitutedValue,
    )
    expect(
      inj4.dependencies.inj2.dependencies.dep2.dependencies.dep1.value,
    ).toBe(substitutedValue)

    const inj5 = substitute(inj2, {
      dep2: { dep1: createValueInjectable(substitutedValue) },
    })
    expect(inj5).not.toBe(inj2)
    expect(inj5.dependencies.dep2.dependencies.dep1.value).toBe(
      substitutedValue,
    )
  })
})

describe('Container', () => {
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

  it('should resolve factory dependencies', async () => {
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

  it('should dispose factory injectable', async () => {
    const spy = vi.fn()
    const injectable = createFactoryInjectable({
      factory: () => ({}),
      dispose: spy,
    })
    await container.resolve(injectable)
    await container.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('should cache factory injectable', async () => {
    const injectable = createFactoryInjectable(() => ({}))
    const val = await container.resolve(injectable)
    expect(container.contains(injectable)).toBe(true)
    expect(await container.resolve(injectable)).toBe(val)
  })

  it('should handle factory injectable dispose error', async () => {
    const injectable = createFactoryInjectable({
      factory: () => ({}),
      dispose: () => {
        throw new Error()
      },
    })
    await container.resolve(injectable)
    await expect(container.dispose()).resolves.not.toThrow()
  })

  it('should resolve with class', async () => {
    class injectable extends createClassInjectable() {}
    const instance = await container.resolve(injectable)
    expect(instance).toBeDefined()
    expect(instance).toBeInstanceOf(injectable)
  })

  it('should resolve class dependencies', async () => {
    const dep1 = createValueInjectable('dep1' as const)
    const dep2 = createFactoryInjectable({
      dependencies: { dep1 },
      factory: (deps) => deps,
    })
    const dep3 = createFactoryInjectable(() => 'dep3' as const)
    class injectable extends createClassInjectable({ dep2, dep3 }) {}
    const { $context: deps } = await container.resolve(injectable)
    expect(deps).toHaveProperty('dep2', { dep1: 'dep1' })
    expect(deps).toHaveProperty('dep3', 'dep3')
  })

  it('should call class injectable hooks', async () => {
    const createSpy = vi.fn()
    const disposeSpy = vi.fn()
    class injectable extends createClassInjectable() {
      protected async $onCreate() {
        createSpy()
      }
      protected async $onDispose() {
        disposeSpy()
      }
    }
    await container.resolve(injectable)
    await container.dispose()
    expect(createSpy).toHaveBeenCalledOnce()
    expect(disposeSpy).toHaveBeenCalledOnce()
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
    const scopeContainer = container.fork(Scope.Call)
    expect(scopeContainer).toBeInstanceOf(Container)
    expect(scopeContainer).not.toBe(container)
    expect(scopeContainer).toHaveProperty('parent')
  })

  it('should correctly resolve injectable scope', async () => {
    const injectable = createLazyInjectable(Scope.Connection)
    const injectable2 = createLazyInjectable(Scope.Call)
    const injectable3 = createFactoryInjectable({
      dependencies: { injectable, injectable2 },
      factory: noopFn,
    })
    expect(getInjectableScope(injectable3)).toBe(Scope.Call)
  })

  it('should correctly resolve injectable pick', async () => {
    const v1 = {}
    const v2 = { v1 }
    const injectable = createFactoryInjectable({
      factory: () => v2,
      pick: ({ v1 }) => v1,
    })

    await expect(container.resolve(injectable)).resolves.toBe(v1)
  })

  it('should resolve scopes', async () => {
    const globalInjectableValue = {}
    const globalInjectable = createFactoryInjectable(
      () => globalInjectableValue,
      'global',
    )

    const connectionInjectable = createFactoryInjectable(
      {
        dependencies: { globalValue: globalInjectable },
        scope: Scope.Connection,
        factory: (deps) => deps,
      },
      'connection',
    )

    const callInjectable = createFactoryInjectable(
      {
        dependencies: {
          globalValue: globalInjectable,
          connectionValue: connectionInjectable,
        },
        scope: Scope.Call,
        factory: ({ globalValue, connectionValue }) => {
          return { globalValue, connectionValue }
        },
      },
      'call',
    )

    const scopeContainer = container.fork(Scope.Call)
    const callInjectableValue = await scopeContainer.resolve(callInjectable)

    expect(container.contains(globalInjectable)).toBe(true)
    expect(container.containsWithinSelf(globalInjectable)).toBe(true)

    expect(callInjectableValue.globalValue).toBe(globalInjectableValue)

    expect((scopeContainer as any).parent).toBe(container)
    expect(scopeContainer.containsWithinSelf(globalInjectable)).toBe(false)
    expect(scopeContainer.contains(globalInjectable)).toBe(true)
    expect(scopeContainer.containsWithinSelf(connectionInjectable)).toBe(true)
    expect(scopeContainer.contains(connectionInjectable)).toBe(true)

    const connectionInjectableValue =
      await scopeContainer.resolve(connectionInjectable)
    expect(callInjectableValue.globalValue).toBe(
      connectionInjectableValue.globalValue,
    )
    expect(scopeContainer.contains(globalInjectable)).toBe(true)
    await scopeContainer.dispose()
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

    const dependant = createFactoryInjectable({
      dependencies: { injectable1, injectable2 },
      factory: noopFn,
    })

    vi.spyOn(registry, 'getDependants').mockImplementationOnce(function* () {
      yield dependant
    })

    await container.load()

    expect(factory1).toHaveBeenCalledOnce()
    expect(factory2).not.toHaveBeenCalled()
  })

  it('should dispose in correct order', async () => {
    const disposeSpy = vi.fn((value) => order.push(value))
    const order: string[] = []

    const testGlobalContainer = container.fork(Scope.Global)

    const injectable1 = createFactoryInjectable(
      {
        factory: () => '1',
        dispose: disposeSpy,
      },
      'inj1',
    )

    const injectable2 = createFactoryInjectable(
      {
        dependencies: { injectable1 },
        factory: () => '2',
        dispose: disposeSpy,
      },
      'inj2',
    )

    const injectable3 = createFactoryInjectable(
      {
        dependencies: { injectable1, injectable2 },
        factory: () => '3',
        dispose: disposeSpy,
      },
      'inj3',
    )

    const injectable4 = createFactoryInjectable(
      {
        scope: Scope.Connection,
        dependencies: { injectable1, injectable3 },
        factory: () => '4',
        dispose: disposeSpy,
      },
      'inj4',
    )

    const injectable5 = createFactoryInjectable(
      {
        dependencies: { injectable2, injectable4 },
        factory: () => '5',
        dispose: disposeSpy,
      },
      'inj5',
    )
    const testConnectionContainer = testGlobalContainer.fork(Scope.Connection)
    await testConnectionContainer.resolve(injectable5)
    await testConnectionContainer.dispose()
    await testGlobalContainer.dispose()

    expect(order).toStrictEqual(['5', '4', '3', '2', '1'])
  })

  it('should fail to resolve required dependency', async () => {
    const lazyInjectable = createLazyInjectable()
    const injectable = createFactoryInjectable({
      dependencies: { dep: lazyInjectable },
      factory: noopFn,
    })
    await expect(container.resolve(injectable)).rejects.toThrow(
      'No instance provided for an injectable',
    )
  })

  it('should resolve optional dependency', async () => {
    const injectable = createFactoryInjectable({
      dependencies: { dep: createOptionalInjectable(CoreInjectables.logger) },
      factory: noopFn,
    })
    await expect(container.resolve(injectable)).rejects.toThrow()
  })
})
