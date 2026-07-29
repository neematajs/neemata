/**
 * Known container/DI issues found during review that are NOT fixed yet.
 * Each test asserts the CORRECT behavior and is marked with `it.fails`,
 * so the suite stays green while the bug persists — and starts failing
 * (i.e. demands removal of the `.fails` marker) once the bug gets fixed.
 */
import { describe, expect, it, vi } from 'vitest'

import { Container } from '../src/container.ts'
import { Scope } from '../src/enums.ts'
import {
  CoreInjectables,
  createFactoryInjectable,
  createLazyInjectable,
} from '../src/injectables.ts'
import { testLogger } from './_utils.ts'

const logger = testLogger()
const makeContainer = () => new Container({ logger })

describe('get() with injectable provisions', () => {
  it.fails('returns the resolved instance after the provision has been resolved', async () => {
    const container = makeContainer()
    const token = createLazyInjectable()
    const value = { foo: 'bar' }
    const factory = createFactoryInjectable({ create: () => value })
    container.provide(token, factory)
    const resolved = await container.resolve(token)
    expect(resolved).toBe(value)
    // actual: returns the raw factory injectable, since the instance is
    // cached under the provided injectable rather than the token
    expect(container.get(token)).toBe(value)
  })
})

describe('container-scope guard on resolution', () => {
  it.fails('rejects resolving a Call-scoped injectable on a Global container', async () => {
    const container = makeContainer()
    const callScoped = createFactoryInjectable({
      scope: Scope.Call,
      create: () => ({}),
    })
    // actual: silently creates and caches the "per-call" instance globally
    await expect(container.resolve(callScoped)).rejects.toThrow()
  })

  it.fails('rejects Global -> Transient -> Call scope laundering', async () => {
    const container = makeContainer()
    const callScopedSpy = vi.fn(() => ({}))
    const callScoped = createFactoryInjectable({
      scope: Scope.Call,
      create: callScopedSpy,
    })
    const transient = createFactoryInjectable({
      scope: Scope.Transient,
      dependencies: { callScoped },
      create: (deps) => deps,
    })
    // a direct Global -> Call dependency throws at creation time, but the
    // Transient in between maps to NaN scope strictness and disables every
    // comparison-based check along the chain
    const globalScoped = createFactoryInjectable({
      scope: Scope.Global,
      dependencies: { transient },
      create: (deps) => deps,
    })
    await expect(container.resolve(globalScoped)).rejects.toThrow()
    expect(callScopedSpy).not.toHaveBeenCalled()
  })
})

describe('transient disposal', () => {
  it.fails('disposes every wrapper whose public instance matches', async () => {
    const container = makeContainer()
    const shared = { public: true }
    const disposeSpy = vi.fn()
    const transient = createFactoryInjectable({
      scope: Scope.Transient,
      create: () => ({ inner: Math.random() }),
      pick: () => shared,
      dispose: disposeSpy,
    })
    await container.resolve(transient)
    await container.resolve(transient)
    const dispose = container.get(CoreInjectables.dispose)
    await dispose(transient, shared)
    // actual: the for...of loop splices while iterating and skips the
    // element right after each match
    expect(disposeSpy).toHaveBeenCalledTimes(2)
    expect(container.instances.has(transient)).toBe(false)
  })

  it.fails('keeps child-resolved transient instances in the child container', async () => {
    const container = makeContainer()
    const transient = createFactoryInjectable({
      scope: Scope.Transient,
      create: () => ({}),
    })
    await container.resolve(transient) // parent now "contains" the transient
    const child = container.fork(Scope.Call)
    await child.resolve(transient)
    // actual: parent.contains() delegates the resolution upward, so the
    // instance accumulates in the parent and outlives the child scope
    expect(child.instances.has(transient)).toBe(true)
  })
})
