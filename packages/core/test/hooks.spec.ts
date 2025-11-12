import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Container } from '../src/container.ts'
import { createHook } from '../src/hook.ts'
import { Hooks } from '../src/hooks.ts'
import { Registry } from '../src/registry.ts'
import { testLogger } from './_utils.ts'

describe('Hooks', () => {
  let registry: Registry
  let container: Container
  let hooks: Hooks

  beforeEach(() => {
    const logger = testLogger()
    registry = new Registry({ logger })
    container = new Container({ registry, logger })
    hooks = new Hooks({ container, registry })
  })

  it('does nothing when no hooks are registered for the given name', async () => {
    await expect(hooks.call('missing', [])).resolves.toBeUndefined()
  })

  it('executes registered hooks sequentially by default', async () => {
    const order: string[] = []

    const firstHook = createHook({
      name: 'test',
      handler: vi.fn(async () => {
        order.push('first')
      }),
    })
    const secondHook = createHook({
      name: 'test',
      handler: vi.fn(async () => {
        order.push('second')
      }),
    })

    registry.registerHook(firstHook)
    registry.registerHook(secondHook)

    await hooks.call('test')

    expect(order).toEqual(['first', 'second'])
    expect(firstHook.handler).toHaveBeenCalledWith({})
    expect(secondHook.handler).toHaveBeenCalledWith({})
  })

  it('respects reverse order when specified', async () => {
    const order: string[] = []
    const firstHook = createHook({
      name: 'test',
      handler: vi.fn(async () => {
        order.push('first')
      }),
    })
    const secondHook = createHook({
      name: 'test',
      handler: vi.fn(async () => {
        order.push('second')
      }),
    })

    registry.registerHook(firstHook)
    registry.registerHook(secondHook)

    await hooks.call('test')

    expect(order).toEqual(['first', 'second'])
  })

  it('returns handler results when running concurrently', async () => {
    const firstHook = createHook({
      name: 'test',
      handler: vi.fn(async () => 'first-result'),
    })
    const secondHook = createHook({
      name: 'test',
      handler: vi.fn(async () => 'second-result'),
    })
    registry.registerHook(firstHook)
    registry.registerHook(secondHook)

    const args = ['payload']
    await hooks.call('test', ...args)

    expect(firstHook.handler).toHaveBeenCalledWith({}, ...args)
    expect(secondHook.handler).toHaveBeenCalledWith({}, ...args)
  })
})
