import { describe, expect, it, vi } from 'vitest'

import { Lifecycle, TeardownStack } from '../src/lifecycle.ts'
import { createFuture } from '../src/utils.ts'

describe('TeardownStack', () => {
  it('unwinds in reverse registration order and clears itself', async () => {
    const stack = new TeardownStack()
    const order: string[] = []
    stack.defer(() => {
      order.push('first')
    })
    stack.defer(async () => {
      order.push('second')
    })
    stack.defer(() => {
      order.push('third')
    })
    expect(stack.size).toBe(3)

    await expect(stack.unwind()).resolves.toStrictEqual([])
    expect(order).toStrictEqual(['third', 'second', 'first'])
    expect(stack.size).toBe(0)

    // a second unwind has nothing left to run
    await expect(stack.unwind()).resolves.toStrictEqual([])
    expect(order).toStrictEqual(['third', 'second', 'first'])
  })

  it('runs every teardown even when some throw and collects the errors', async () => {
    const stack = new TeardownStack()
    const order: string[] = []
    const syncError = new Error('sync teardown failed')
    const asyncError = new Error('async teardown failed')
    stack.defer(() => {
      order.push('first')
    })
    stack.defer(async () => {
      throw asyncError
    })
    stack.defer(() => {
      throw syncError
    })
    stack.defer(() => {
      order.push('last')
    })

    // unwind order is LIFO, so errors are collected newest-registered first
    await expect(stack.unwind()).resolves.toStrictEqual([syncError, asyncError])
    expect(order).toStrictEqual(['last', 'first'])
    expect(stack.size).toBe(0)
  })
})

describe('Lifecycle', () => {
  it('returns the run result and transitions idle -> running -> idle', async () => {
    const lifecycle = new Lifecycle<string>('component')
    expect(lifecycle.state).toBe('idle')

    const teardown = vi.fn()
    await expect(
      lifecycle.start(async (defer) => {
        expect(lifecycle.state).toBe('starting')
        defer(teardown)
        return 'started'
      }),
    ).resolves.toBe('started')
    expect(lifecycle.state).toBe('running')
    expect(teardown).not.toHaveBeenCalled()

    await lifecycle.stop()
    expect(lifecycle.state).toBe('idle')
    expect(teardown).toHaveBeenCalledOnce()
  })

  it('rejects a second start while running without touching the first start state', async () => {
    const lifecycle = new Lifecycle<number>('component')
    const teardown = vi.fn()
    await lifecycle.start(async (defer) => {
      defer(teardown)
      return 1
    })

    const secondRun = vi.fn(async () => 2)
    await expect(lifecycle.start(secondRun)).rejects.toThrow(
      'The component is already started',
    )
    expect(secondRun).not.toHaveBeenCalled()
    expect(lifecycle.state).toBe('running')
    expect(teardown).not.toHaveBeenCalled()

    await lifecycle.stop()
    expect(teardown).toHaveBeenCalledOnce()
  })

  it('no-ops stop when idle', async () => {
    const lifecycle = new Lifecycle('component')
    await expect(lifecycle.stop()).resolves.toBeUndefined()
    expect(lifecycle.state).toBe('idle')
  })

  it('serializes a stop issued during an in-flight start', async () => {
    const lifecycle = new Lifecycle<string>('component')
    const gate = createFuture<void>()
    const order: string[] = []

    const start = lifecycle.start(async (defer) => {
      order.push('start:begin')
      defer(() => {
        order.push('teardown')
      })
      await gate.promise
      order.push('start:end')
      return 'url'
    })
    const stop = lifecycle.stop()

    await Promise.resolve()
    expect(lifecycle.state).toBe('starting')
    expect(order).toStrictEqual(['start:begin'])

    gate.resolve(undefined)
    await expect(start).resolves.toBe('url')
    await stop
    // the queued stop ran only after the start finished
    expect(order).toStrictEqual(['start:begin', 'start:end', 'teardown'])
    expect(lifecycle.state).toBe('idle')
  })

  it('rejects an overlapping start queued behind an in-flight one', async () => {
    const lifecycle = new Lifecycle<number>('component')
    const gate = createFuture<void>()
    const teardown = vi.fn()

    const first = lifecycle.start(async (defer) => {
      defer(teardown)
      await gate.promise
      return 1
    })
    const secondRun = vi.fn(async () => 2)
    const second = lifecycle.start(secondRun)

    gate.resolve(undefined)
    await expect(first).resolves.toBe(1)
    await expect(second).rejects.toThrow('The component is already started')
    expect(secondRun).not.toHaveBeenCalled()
    expect(lifecycle.state).toBe('running')
    expect(teardown).not.toHaveBeenCalled()

    await lifecycle.stop()
    expect(teardown).toHaveBeenCalledOnce()
  })

  it('unwinds only what a failed start deferred, rethrows the original error bare and stays restartable', async () => {
    const lifecycle = new Lifecycle<string>('component')
    const failure = new Error('start failed')
    const order: string[] = []

    await expect(
      lifecycle.start(async (defer) => {
        defer(() => {
          order.push('undo:a')
        })
        defer(() => {
          order.push('undo:b')
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    // rollback runs in reverse acquisition order
    expect(order).toStrictEqual(['undo:b', 'undo:a'])
    expect(lifecycle.state).toBe('idle')

    // the failure neither poisoned the queue nor left stale teardowns behind
    await expect(lifecycle.start(async () => 'again')).resolves.toBe('again')
    expect(lifecycle.state).toBe('running')
    await lifecycle.stop()
    expect(order).toStrictEqual(['undo:b', 'undo:a'])
  })

  it('wraps a failed start in an AggregateError only when the rollback itself fails', async () => {
    const lifecycle = new Lifecycle('component')
    const failure = new Error('start failed')
    const rollbackFailure = new Error('rollback failed')

    await expect(
      lifecycle.start(async (defer) => {
        defer(() => {
          throw rollbackFailure
        })
        throw failure
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof AggregateError &&
        error.message ===
          'Failed to start the component and roll back resources' &&
        error.errors[0] === failure &&
        error.errors[1] === rollbackFailure,
    )
    expect(lifecycle.state).toBe('idle')
  })

  it('aggregates stop unwind errors and stays usable afterwards', async () => {
    const lifecycle = new Lifecycle('component')
    const firstError = new Error('first teardown failed')
    const secondError = new Error('second teardown failed')

    await lifecycle.start(async (defer) => {
      defer(() => {
        throw firstError
      })
      defer(() => {
        throw secondError
      })
      return 'ok'
    })

    await expect(lifecycle.stop()).rejects.toSatisfy(
      (error) =>
        error instanceof AggregateError &&
        error.message === 'Failed to stop the component' &&
        // LIFO unwind surfaces the later-deferred teardown's error first
        error.errors[0] === secondError &&
        error.errors[1] === firstError,
    )
    expect(lifecycle.state).toBe('idle')

    // the rejected stop did not poison the queue
    await expect(lifecycle.start(async () => 'again')).resolves.toBe('again')
    await lifecycle.stop()
  })
})
