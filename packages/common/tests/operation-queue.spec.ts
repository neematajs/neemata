import { describe, expect, it } from 'vitest'

import {
  OperationQueue,
  OperationSupersededError,
} from '../src/operation-queue.ts'
import { createFuture } from '../src/utils.ts'

describe('OperationQueue', () => {
  it('runs operations one at a time in enqueue order', async () => {
    const queue = new OperationQueue()
    const releaseFirst = createFuture<void>()
    const order: string[] = []

    const first = queue.run(async () => {
      order.push('first:start')
      await releaseFirst.promise
      order.push('first:end')
      return 1
    })
    const second = queue.run(() => {
      order.push('second:start')
      return 2
    })

    await Promise.resolve()

    expect(queue.pending).toBe(2)
    expect(queue.busy).toBe(true)
    expect(order).toEqual(['first:start'])

    releaseFirst.resolve(undefined)

    await expect(first).resolves.toBe(1)
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(queue.pending).toBe(0)
    expect(queue.busy).toBe(false)
  })

  it('continues after a failed operation and preserves caller errors', async () => {
    const queue = new OperationQueue()

    const failed = queue.run(async () => {
      throw new Error('boom')
    })
    const next = queue.run(() => 'ok')

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(queue.pending).toBe(0)
  })

  it('waits until queued operations settle', async () => {
    const queue = new OperationQueue()
    const release = createFuture<void>()
    const events: string[] = []

    void queue.run(async () => {
      await release.promise
      events.push('operation')
    })
    const idle = queue.waitIdle().then(() => {
      events.push('idle')
    })

    await Promise.resolve()

    expect(events).toEqual([])
    release.resolve(undefined)

    await idle
    expect(events).toEqual(['operation', 'idle'])
  })

  it('can run only the latest pending operation', async () => {
    const queue = new OperationQueue({ strategy: 'latest' })
    const releaseFirst = createFuture<void>()
    const order: string[] = []

    const first = queue.run(async () => {
      order.push('first:start')
      await releaseFirst.promise
      order.push('first:end')
      return 'first'
    })
    const second = queue.run(() => {
      order.push('second:start')
      return 'second'
    })
    const third = queue.run(() => {
      order.push('third:start')
      return 'third'
    })

    await Promise.resolve()

    expect(queue.pending).toBe(2)
    expect(order).toEqual(['first:start'])
    await expect(second).rejects.toBeInstanceOf(OperationSupersededError)

    releaseFirst.resolve(undefined)

    await expect(first).resolves.toBe('first')
    await expect(third).resolves.toBe('third')
    expect(order).toEqual(['first:start', 'first:end', 'third:start'])
    expect(queue.pending).toBe(0)
  })
})
