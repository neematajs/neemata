import { describe, expect, it, vi } from 'vitest'

import {
  isOperationAborted,
  OperationScope,
} from '../../src/internal/host/lifecycle.ts'
import { throwCollected } from '../../src/internal/utils.ts'

describe('OperationScope', () => {
  it('settles a pending wait at once when an ancestor aborts', async () => {
    const root = new OperationScope()
    const child = root.child()
    const never = new Promise<void>(() => {})

    const waiting = child.wait(never).catch((error: unknown) => error)
    root.abort()

    const error = await waiting
    expect(isOperationAborted(error)).toBe(true)
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(child.aborted).toBe(true)
    expect(() => root.child().throwIfAborted()).toThrow('aborted')
  })

  it('passes through the outcome of what it waits for', async () => {
    const scope = new OperationScope()

    await expect(scope.wait(Promise.resolve('value'))).resolves.toBe('value')
    await expect(
      scope.wait(Promise.reject(new Error('failed'))),
    ).rejects.toThrow('failed')
  })

  it('never extends the deadline it inherits', () => {
    const now = Date.now()
    const scope = new OperationScope({ deadline: now + 1_000 })

    expect(scope.child().deadline).toBe(now + 1_000)
    expect(
      new OperationScope({ parent: scope, deadline: now + 60_000 }).deadline,
    ).toBe(now + 1_000)
    expect(scope.remaining()).toBeLessThanOrEqual(1_000)
    expect(new OperationScope().remaining()).toBe(Number.POSITIVE_INFINITY)
    expect(new OperationScope({ deadline: now - 5 }).remaining()).toBe(0)
  })

  it('handles the rejection of a promise launched after an abort', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const scope = new OperationScope()
      scope.abort()

      // The argument is evaluated first, as in `wait(host.start())`.
      await expect(
        scope.wait(Promise.reject(new Error('runner exited'))),
      ).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('fails a step that misses the deadline and leaves it running', async () => {
    const scope = OperationScope.withTimeout(20)
    const startedAt = Date.now()

    await expect(
      scope.within(new Promise(() => {}), 'Neem hook [server:stop]'),
    ).rejects.toThrow(
      'Neem hook [server:stop] did not finish within the stop budget',
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    // A step that settles synchronously still completes on a spent budget.
    const spent = new OperationScope({ deadline: Date.now() - 1 })
    await expect(spent.within(Promise.resolve('done'), 'step')).resolves.toBe(
      'done',
    )
    await expect(
      spent.within(Promise.reject(new Error('failed')), 'step'),
    ).rejects.toThrow('failed')
  })

  it('interrupts a sleep when aborted', async () => {
    const scope = new OperationScope()
    const sleeping = scope.sleep(60_000).catch((error: unknown) => error)

    scope.abort()

    expect(isOperationAborted(await sleeping)).toBe(true)
  })

  it('stops notifying a disposed child', () => {
    const root = new OperationScope()
    const child = root.child()

    child.dispose()
    root.abort()

    expect(child.aborted).toBe(false)
  })
})

describe('throwCollected', () => {
  it('throws a single error as is and several together', () => {
    const first = new Error('first')
    const second = new Error('second')

    expect(() => throwCollected([], 'stop failed')).not.toThrow()
    expect(() => throwCollected([first], 'stop failed')).toThrow(first)
    try {
      throwCollected([first, second], 'stop failed')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect(error).toMatchObject({
        message: 'stop failed: first; second',
        errors: [first, second],
      })
    }
  })
})
