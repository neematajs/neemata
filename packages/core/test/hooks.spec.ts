import { beforeEach, describe, expect, test, vi } from 'vitest'
import { kHookCollection } from '../src/constants.ts'
import { Hooks } from '../src/hooks.ts'

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
