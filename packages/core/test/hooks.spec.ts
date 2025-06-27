import { beforeEach, describe, expect, test, vi } from 'vitest'
import { kHookCollection } from '../src/constants.ts'
import { Container } from '../src/container.ts'
import { Hook } from '../src/enums.ts'
import { Hooks } from '../src/hooks.ts'
import { CoreInjectables, createFactoryInjectable } from '../src/injectables.ts'
import { Registry } from '../src/registry.ts'
import { testLogger } from './_utils.ts'

describe('Hooks', () => {
  let hooks: Hooks

  beforeEach(() => {
    hooks = new Hooks()
  })

  test('should add a hook', () => {
    const callback = vi.fn()
    hooks.add('test', callback)
    expect(hooks[kHookCollection].get('test')).toContain(callback)
  })

  test('should remove a hook', () => {
    const callback = vi.fn()
    hooks.add('test', callback)
    hooks.remove('test', callback)
    expect(hooks[kHookCollection].get('test')).not.toContain(callback)
  })

  test('should call a hook', async () => {
    const callback = vi.fn()
    hooks.add('test', callback)
    await hooks.call('test', { concurrent: true })
    expect(callback).toHaveBeenCalled()
  })

  test('should merge hooks', () => {
    const callback1 = vi.fn()
    const callback2 = vi.fn()
    const hooks2 = new Hooks()
    hooks.add('test', callback1)
    hooks2.add('test', callback2)
    Hooks.merge(hooks2, hooks)
    expect(hooks[kHookCollection].get('test')).toContain(callback1)
    expect(hooks[kHookCollection].get('test')).toContain(callback2)
  })

  test('should clear hooks', () => {
    const callback = vi.fn()
    hooks.add('test', callback)
    hooks.clear()
    expect(hooks[kHookCollection].get('test')).toBeUndefined()
  })
})

describe('Hooks injectables', () => {
  const logger = testLogger()
  const registry = new Registry({ logger })
  const container = new Container({ registry, logger })

  test('should properly handle inline hooks', async () => {
    const hookSpy = vi.fn()
    const injectable = createFactoryInjectable({
      dependencies: {
        hook: CoreInjectables.hook,
      },
      factory: ({ hook }) => {
        hook(Hook.OnDisconnect, hookSpy)
      },
    })

    await container.resolve(injectable)

    expect(registry.hooks[kHookCollection].get(Hook.OnDisconnect)?.size).toBe(1)
    const connection = {}
    registry.hooks.call(Hook.OnDisconnect, {}, connection)
    expect(hookSpy).toHaveBeenCalledWith(connection)

    await container.dispose()

    expect(registry.hooks[kHookCollection].get(Hook.OnDisconnect)?.size).toBe(0)
    registry.hooks.call(Hook.OnDisconnect, {}, connection)
    expect(hookSpy).toHaveBeenCalledTimes(1)
  })
})
