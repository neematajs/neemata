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

  describe('Race Condition Prevention', () => {
    it('should prevent race conditions during concurrent resolution', async () => {
      let factoryCallCount = 0
      const injectable = createFactoryInjectable({
        factory: async () => {
          factoryCallCount++
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { id: factoryCallCount }
        },
      })

      const promises = Array.from({ length: 5 }, () =>
        container.resolve(injectable),
      )
      const results = await Promise.all(promises)

      expect(factoryCallCount).toBe(1)

      const firstResult = results[0]
      results.forEach((result) => {
        expect(result).toBe(firstResult)
        expect(result.id).toBe(1)
      })
    })

    it('should handle resolution failures properly without memory leaks', async () => {
      const errorMessage = 'Factory failed'
      const injectable = createFactoryInjectable({
        factory: async (): Promise<string> => {
          throw new Error(errorMessage)
        },
      })

      await expect(container.resolve(injectable)).rejects.toThrow(errorMessage)

      expect(container.containsWithinSelf(injectable)).toBe(false)

      await expect(container.resolve(injectable)).rejects.toThrow(errorMessage)
    })
  })

  describe('Enhanced Dependency Tracking', () => {
    it('should track dependencies across different scopes', async () => {
      const globalDep = createFactoryInjectable({
        factory: () => 'global',
        scope: Scope.Global,
      })

      const connectionDep = createFactoryInjectable({
        dependencies: { globalDep },
        factory: (deps) => ({ value: 'connection', global: deps.globalDep }),
        scope: Scope.Connection,
      })

      await container.resolve(globalDep)

      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(connectionDep)

      expect(container.contains(globalDep)).toBe(true)
      expect(connectionContainer.contains(connectionDep)).toBe(true)
      expect(connectionContainer.contains(globalDep)).toBe(true)
    })
  })

  describe('Proper Disposal Order', () => {
    it('should dispose dependencies in correct order (dependants before dependencies)', async () => {
      const disposalOrder: string[] = []

      const dep1 = createFactoryInjectable({
        factory: () => 'dep1',
        dispose: () => {
          disposalOrder.push('dep1')
        },
      })

      const dep2 = createFactoryInjectable({
        dependencies: { dep1 },
        factory: (deps) => ({ value: 'dep2', dep1: deps.dep1 }),
        dispose: () => {
          disposalOrder.push('dep2')
        },
      })

      const dep3 = createFactoryInjectable({
        dependencies: { dep2 },
        factory: (deps) => ({ value: 'dep3', dep2: deps.dep2 }),
        dispose: () => {
          disposalOrder.push('dep3')
        },
      })

      await container.resolve(dep1)
      await container.resolve(dep2)
      await container.resolve(dep3)

      await container.dispose()

      expect(disposalOrder).toEqual(['dep3', 'dep2', 'dep1'])
    })

    it('should handle complex dependency graphs during disposal', async () => {
      const disposalOrder: string[] = []

      const depA = createFactoryInjectable({
        factory: () => 'A',
        dispose: () => {
          disposalOrder.push('A')
        },
      })

      const depB = createFactoryInjectable({
        dependencies: { depA },
        factory: (deps) => ({ value: 'B', depA: deps.depA }),
        dispose: () => {
          disposalOrder.push('B')
        },
      })

      const depC = createFactoryInjectable({
        dependencies: { depA },
        factory: (deps) => ({ value: 'C', depA: deps.depA }),
        dispose: () => {
          disposalOrder.push('C')
        },
      })

      const depD = createFactoryInjectable({
        dependencies: { depB, depC },
        factory: (deps) => ({ value: 'D', depB: deps.depB, depC: deps.depC }),
        dispose: () => {
          disposalOrder.push('D')
        },
      })

      await container.resolve(depD)
      await container.dispose()

      expect(disposalOrder[0]).toBe('D')
      expect(disposalOrder[3]).toBe('A')
      expect(disposalOrder.slice(1, 3).sort()).toEqual(['B', 'C'])
    })
  })

  describe('Disposal Lock', () => {
    it('should prevent new resolutions during disposal', async () => {
      const injectable = createFactoryInjectable({
        factory: () => 'test',
      })

      // Start disposal (but don't await it yet)
      const disposalPromise = container.dispose()

      // Try to resolve during disposal - should fail
      expect(() => container.resolve(injectable)).toThrow(
        'Cannot resolve during disposal',
      )

      // Wait for disposal to complete
      await disposalPromise
    })

    it('should allow resolution in new container after disposal', async () => {
      const injectable = createFactoryInjectable({
        factory: () => 'test',
      })

      await container.dispose()

      // Create new container - should work fine
      const newContainer = new Container({ registry, logger })
      await newContainer.load()

      await expect(newContainer.resolve(injectable)).resolves.toBe('test')

      await newContainer.dispose()
    })

    it('should prevent resolution attempts during disposal process', async () => {
      let disposalStarted = false
      let resolutionAttempted = false

      const slowDisposingInjectable = createFactoryInjectable({
        factory: () => 'slow',
        dispose: async () => {
          disposalStarted = true
          // Simulate slow disposal
          await new Promise((resolve) => setTimeout(resolve, 50))
        },
      })

      const quickInjectable = createFactoryInjectable({
        factory: () => 'quick',
      })

      await container.resolve(slowDisposingInjectable)

      // Start disposal
      const disposalPromise = container.dispose()

      // Wait a bit to ensure disposal has started
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Try to resolve during disposal
      try {
        await container.resolve(quickInjectable)
      } catch (error) {
        resolutionAttempted = true
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('Cannot resolve during disposal')
      }

      await disposalPromise

      expect(disposalStarted).toBe(true)
      expect(resolutionAttempted).toBe(true)
    })
  })

  describe('Disposal with Parent-Child Containers', () => {
    it('should not dispose parent dependencies when disposing child container', async () => {
      const disposalOrder: string[] = []

      const parentDep = createFactoryInjectable({
        factory: () => 'parent',
        scope: Scope.Global,
        dispose: () => {
          disposalOrder.push('parent')
        },
      })

      const childDep = createFactoryInjectable({
        dependencies: { parentDep },
        factory: (deps) => ({ value: 'child', parent: deps.parentDep }),
        scope: Scope.Connection,
        dispose: () => {
          disposalOrder.push('child')
        },
      })

      // Resolve parent dependency in global container
      await container.resolve(parentDep)

      // Fork to connection scope and resolve child dependency
      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(childDep)

      // Dispose child container - should not dispose parent dependency
      await connectionContainer.dispose()

      // Only child should be disposed, not parent
      expect(disposalOrder).toEqual(['child'])

      // Parent should still be available in global container
      expect(container.contains(parentDep)).toBe(true)

      // Dispose parent container
      await container.dispose()

      // Now parent should be disposed
      expect(disposalOrder).toEqual(['child', 'parent'])
    })

    it('should handle complex parent-child dependency chains during disposal', async () => {
      const disposalOrder: string[] = []

      const globalDep = createFactoryInjectable({
        factory: () => 'global',
        scope: Scope.Global,
        dispose: () => {
          disposalOrder.push('global')
        },
      })

      const connectionDep1 = createFactoryInjectable({
        dependencies: { globalDep },
        factory: (deps) => ({ value: 'conn1', global: deps.globalDep }),
        scope: Scope.Connection,
        dispose: () => {
          disposalOrder.push('conn1')
        },
      })

      const connectionDep2 = createFactoryInjectable({
        dependencies: { globalDep, connectionDep1 },
        factory: (deps) => ({
          value: 'conn2',
          global: deps.globalDep,
          conn1: deps.connectionDep1,
        }),
        scope: Scope.Connection,
        dispose: () => {
          disposalOrder.push('conn2')
        },
      })

      const callDep = createFactoryInjectable({
        dependencies: { globalDep, connectionDep2 },
        factory: (deps) => ({
          value: 'call',
          global: deps.globalDep,
          conn2: deps.connectionDep2,
        }),
        scope: Scope.Call,
        dispose: () => {
          disposalOrder.push('call')
        },
      })

      // Resolve global dependency
      await container.resolve(globalDep)

      // Fork to connection scope
      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(connectionDep1)
      await connectionContainer.resolve(connectionDep2)

      // Fork to call scope
      const callContainer = connectionContainer.fork(Scope.Call)
      await callContainer.resolve(callDep)

      // Dispose call container
      await callContainer.dispose()
      expect(disposalOrder).toEqual(['call'])

      // Dispose connection container
      await connectionContainer.dispose()
      expect(disposalOrder).toEqual(['call', 'conn2', 'conn1'])

      // Dispose global container
      await container.dispose()
      expect(disposalOrder).toEqual(['call', 'conn2', 'conn1', 'global'])
    })

    it('should properly clean up dependency tracking in child containers', async () => {
      const parentDep = createFactoryInjectable({
        factory: () => 'parent',
        scope: Scope.Global,
      })

      const childDep = createFactoryInjectable({
        dependencies: { parentDep },
        factory: (deps) => ({ value: 'child', parent: deps.parentDep }),
        scope: Scope.Connection,
      })

      // Fork container and resolve dependencies
      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(childDep)

      // Check that dependency tracking is set up
      expect(connectionContainer.contains(childDep)).toBe(true)
      expect(connectionContainer.contains(parentDep)).toBe(true)
      expect(container.contains(parentDep)).toBe(true)

      // Dispose child container
      await connectionContainer.dispose()

      // Child container should be clean
      expect(connectionContainer.containsWithinSelf(childDep)).toBe(false)
      expect(connectionContainer.containsWithinSelf(parentDep)).toBe(false)

      // Parent should still have its dependency
      expect(container.contains(parentDep)).toBe(true)
    })

    it('should prevent disposal of dependencies still needed by other containers', async () => {
      const sharedDep = createFactoryInjectable({
        factory: () => 'shared',
        scope: Scope.Global,
      })

      const childDep1 = createFactoryInjectable({
        dependencies: { sharedDep },
        factory: (deps) => ({ value: 'child1', shared: deps.sharedDep }),
        scope: Scope.Connection,
      })

      const childDep2 = createFactoryInjectable({
        dependencies: { sharedDep },
        factory: (deps) => ({ value: 'child2', shared: deps.sharedDep }),
        scope: Scope.Connection,
      })

      // Create two connection containers sharing the same global dependency
      const conn1Container = container.fork(Scope.Connection)
      const conn2Container = container.fork(Scope.Connection)

      await conn1Container.resolve(childDep1)
      await conn2Container.resolve(childDep2)

      // Both should share the same global dependency
      const sharedInstance1 = await conn1Container.resolve(sharedDep)
      const sharedInstance2 = await conn2Container.resolve(sharedDep)
      expect(sharedInstance1).toBe(sharedInstance2)

      // Dispose first container
      await conn1Container.dispose()

      // Shared dependency should still be available through parent
      expect(container.contains(sharedDep)).toBe(true)
      expect(conn2Container.contains(sharedDep)).toBe(true)

      // Dispose second container
      await conn2Container.dispose()

      // Shared dependency should still be in parent
      expect(container.contains(sharedDep)).toBe(true)
    })

    it('should handle disposal when parent container is disposed first', async () => {
      const parentDep = createFactoryInjectable({
        factory: () => 'parent',
        scope: Scope.Global,
        dispose: vi.fn(),
      })

      const childDep = createFactoryInjectable({
        dependencies: { parentDep },
        factory: (deps) => ({ value: 'child', parent: deps.parentDep }),
        scope: Scope.Connection,
        dispose: vi.fn(),
      })

      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(childDep)

      // Dispose parent first
      await container.dispose()

      // Child container should still be disposable without errors
      await expect(connectionContainer.dispose()).resolves.not.toThrow()
    })

    it('should only dispose instances that belong to the current container', async () => {
      const disposeSpy = vi.fn()

      const parentDep = createFactoryInjectable({
        factory: () => 'parent',
        scope: Scope.Global,
        dispose: disposeSpy,
      })

      const childDep = createFactoryInjectable({
        dependencies: { parentDep },
        factory: (deps) => ({ value: 'child', parent: deps.parentDep }),
        scope: Scope.Connection,
        dispose: disposeSpy,
      })

      // Resolve parent in global container
      await container.resolve(parentDep)

      // Create child container and resolve child dependency
      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(childDep)

      // Verify initial state
      expect(container.containsWithinSelf(parentDep)).toBe(true)
      expect(connectionContainer.containsWithinSelf(childDep)).toBe(true)
      expect(connectionContainer.containsWithinSelf(parentDep)).toBe(false)

      // Reset spy
      disposeSpy.mockClear()

      // Dispose child container
      await connectionContainer.dispose()

      // Should only dispose childDep, not parentDep
      expect(disposeSpy).toHaveBeenCalledTimes(1)
      expect(disposeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'child' }),
        expect.any(Object),
      )

      // Reset spy
      disposeSpy.mockClear()

      // Dispose parent container
      await container.dispose()

      // Should dispose parentDep
      expect(disposeSpy).toHaveBeenCalledTimes(1)
      expect(disposeSpy).toHaveBeenCalledWith('parent', expect.any(Object))
    })

    it('should not include parent dependencies in disposal order calculation', async () => {
      const parentDep = createFactoryInjectable(
        {
          factory: () => 'parent',
          scope: Scope.Global,
        },
        'parentDep',
      )

      const childDep = createFactoryInjectable(
        {
          dependencies: { parentDep },
          factory: (deps) => ({ value: 'child', parent: deps.parentDep }),
          scope: Scope.Connection,
        },
        'childDep',
      )

      // Resolve parent in global container
      await container.resolve(parentDep)

      // Create child container and resolve child dependency
      const connectionContainer = container.fork(Scope.Connection)
      await connectionContainer.resolve(childDep)

      // Verify what instances each container has
      expect(container.instances.has(parentDep)).toBe(true)
      expect(container.instances.has(childDep)).toBe(false)
      expect(connectionContainer.instances.has(parentDep)).toBe(false)
      expect(connectionContainer.instances.has(childDep)).toBe(true)

      // Get disposal order for child container
      const childDisposalOrder = (connectionContainer as any).getDisposalOrder()

      // Child container should include:
      // 1. childDep (our test dependency)
      // 2. CoreInjectables.inject (provided to every container)
      // It should NOT include parentDep (that belongs to parent container)
      expect(
        childDisposalOrder.filter((dep: any) => dep === childDep),
      ).toHaveLength(1)
      expect(
        childDisposalOrder.filter((dep: any) => dep === parentDep),
      ).toHaveLength(0)
      expect(childDisposalOrder).toHaveLength(2) // childDep + inject function
    })
  })

  describe('Complex Multi-Scope Container Orchestration', () => {
    it('should handle complex dependency graph across all scopes with proper tracking and disposal', async () => {
      const disposalOrder: string[] = []
      const creationOrder: string[] = []

      // Global scope dependencies (shared across all containers)
      const database = createFactoryInjectable(
        {
          factory: () => {
            creationOrder.push('database')
            return { connection: 'db://localhost:5432' }
          },
          dispose: (instance) => {
            disposalOrder.push('database')
          },
          scope: Scope.Global,
        },
        'database',
      )

      const config = createFactoryInjectable(
        {
          factory: () => {
            creationOrder.push('config')
            return { port: 3000, env: 'production' }
          },
          dispose: () => {
            disposalOrder.push('config')
          },
          scope: Scope.Global,
        },
        'config',
      )

      const logger = createFactoryInjectable(
        {
          dependencies: { config },
          factory: ({ config }) => {
            creationOrder.push('logger')
            return {
              log: (msg: string) => {},
            }
          },
          dispose: () => {
            disposalOrder.push('logger')
          },
          scope: Scope.Global,
        },
        'logger',
      )

      // Connection scope dependencies (per-client connection)
      const session = createFactoryInjectable(
        {
          dependencies: { database, config },
          factory: ({ database, config }) => {
            creationOrder.push('session')
            return {
              id: Math.random().toString(36),
              database: database.connection,
              timeout: config.env === 'production' ? 30000 : 5000,
            }
          },
          dispose: (instance) => {
            disposalOrder.push('session')
          },
          scope: Scope.Connection,
        },
        'session',
      )

      const auth = createFactoryInjectable(
        {
          dependencies: { session, logger },
          factory: ({ session, logger }) => {
            creationOrder.push('auth')
            return { userId: 'user123', sessionId: session.id }
          },
          dispose: (instance) => {
            disposalOrder.push('auth')
          },
          scope: Scope.Connection,
        },
        'auth',
      )

      const connectionMetrics = createFactoryInjectable(
        {
          dependencies: { session, logger },
          factory: ({ session, logger }) => {
            creationOrder.push('connectionMetrics')
            return {
              sessionId: session.id,
              startTime: Date.now(),
              requests: 0,
            }
          },
          dispose: (instance) => {
            disposalOrder.push('connectionMetrics')
          },
          scope: Scope.Connection,
        },
        'connectionMetrics',
      )

      // Call scope dependencies (per-RPC call)
      const requestContext = createFactoryInjectable(
        {
          dependencies: { auth, connectionMetrics },
          factory: ({ auth, connectionMetrics }) => {
            creationOrder.push('requestContext')
            connectionMetrics.requests++
            return {
              requestId: Math.random().toString(36),
              userId: auth.userId,
              sessionId: auth.sessionId,
              timestamp: Date.now(),
            }
          },
          dispose: (instance) => {
            disposalOrder.push('requestContext')
          },
          scope: Scope.Call,
        },
        'requestContext',
      )

      const validator = createFactoryInjectable(
        {
          dependencies: { requestContext, logger },
          factory: ({ requestContext, logger }) => {
            creationOrder.push('validator')
            return {
              validate: (data: any) => true,
              requestId: requestContext.requestId,
            }
          },
          dispose: (instance) => {
            disposalOrder.push('validator')
          },
          scope: Scope.Call,
        },
        'validator',
      )

      const businessLogic = createFactoryInjectable(
        {
          dependencies: { requestContext, validator, database, session },
          factory: ({ requestContext, validator, database, session }) => {
            creationOrder.push('businessLogic')
            return {
              process: (data: any) => {
                validator.validate(data)
                return {
                  result: 'processed',
                  requestId: requestContext.requestId,
                  sessionId: session.id,
                  database: database.connection,
                }
              },
            }
          },
          dispose: (instance) => {
            disposalOrder.push('businessLogic')
          },
          scope: Scope.Call,
        },
        'businessLogic',
      )

      // Simulate real application flow

      await container.resolve(database)
      await container.resolve(config)
      await container.resolve(logger)

      expect(creationOrder).toEqual(['database', 'config', 'logger'])

      expect(container.containsWithinSelf(database)).toBe(true)
      expect(container.containsWithinSelf(config)).toBe(true)
      expect(container.containsWithinSelf(logger)).toBe(true)

      const connection1Container = container.fork(Scope.Connection)

      await connection1Container.resolve(session)
      await connection1Container.resolve(auth)
      await connection1Container.resolve(connectionMetrics)

      expect(creationOrder.slice(-3)).toEqual([
        'session',
        'auth',
        'connectionMetrics',
      ])

      expect(connection1Container.containsWithinSelf(session)).toBe(true)
      expect(connection1Container.containsWithinSelf(auth)).toBe(true)
      expect(connection1Container.containsWithinSelf(connectionMetrics)).toBe(
        true,
      )
      expect(connection1Container.contains(database)).toBe(true)
      expect(connection1Container.containsWithinSelf(database)).toBe(false)

      const connection2Container = container.fork(Scope.Connection)

      const prevCreationLength = creationOrder.length
      await connection2Container.resolve(session)
      await connection2Container.resolve(auth)

      const newCreations = creationOrder.slice(prevCreationLength)
      expect(newCreations).toEqual(['session', 'auth'])

      const db1 = await connection1Container.resolve(database)
      const db2 = await connection2Container.resolve(database)
      expect(db1).toBe(db2)

      const call1Container = connection1Container.fork(Scope.Call)

      const call1Result = await call1Container.resolve(businessLogic)
      expect(call1Result.process({ data: 'test' })).toMatchObject({
        result: 'processed',
        requestId: expect.any(String),
        sessionId: expect.any(String),
        database: 'db://localhost:5432',
      })

      const call2Container = connection1Container.fork(Scope.Call)

      await call2Container.resolve(businessLogic)

      const globalDependants = (container as any).dependants
      expect(globalDependants.has(database)).toBe(true)
      expect(globalDependants.has(config)).toBe(true)
      expect(globalDependants.has(logger)).toBe(true)

      const conn1Dependants = (connection1Container as any).dependants
      expect(conn1Dependants.has(session)).toBe(true)
      expect(conn1Dependants.has(auth)).toBe(true)

      await call1Container.dispose()
      await call2Container.dispose()

      expect(
        disposalOrder.filter((d) =>
          ['requestContext', 'validator', 'businessLogic'].includes(d),
        ).length,
      ).toBeGreaterThan(0)

      await connection2Container.dispose()

      const conn2DisposalStart = disposalOrder.length

      await connection1Container.dispose()

      const conn1Disposal = disposalOrder.slice(conn2DisposalStart)
      expect(conn1Disposal).toContain('connectionMetrics')
      expect(conn1Disposal).toContain('auth')
      expect(conn1Disposal).toContain('session')

      const sessionIndex = conn1Disposal.indexOf('session')
      const authIndex = conn1Disposal.indexOf('auth')
      const metricsIndex = conn1Disposal.indexOf('connectionMetrics')

      expect(authIndex).toBeLessThan(sessionIndex)
      expect(metricsIndex).toBeLessThan(sessionIndex)

      expect(container.contains(database)).toBe(true)
      expect(container.contains(config)).toBe(true)
      expect(container.contains(logger)).toBe(true)

      const globalDisposalStart = disposalOrder.length
      await container.dispose()

      const globalDisposal = disposalOrder.slice(globalDisposalStart)
      expect(globalDisposal).toContain('database')
      expect(globalDisposal).toContain('config')
      expect(globalDisposal).toContain('logger')

      const configIndex = globalDisposal.indexOf('config')
      const loggerIndex = globalDisposal.indexOf('logger')
      expect(loggerIndex).toBeLessThan(configIndex)

      const firstCallDisposal = disposalOrder.indexOf('requestContext')
      const firstConnDisposal = disposalOrder.indexOf('session')
      const firstGlobalDisposal = disposalOrder.indexOf('database')

      expect(firstCallDisposal).toBeLessThan(firstConnDisposal)
      expect(firstConnDisposal).toBeLessThan(firstGlobalDisposal)
    })
  })
})
