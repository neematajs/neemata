import { describe, expect, it } from 'vitest'

import { Semaphore, SemaphoreError } from '../src/semaphore.ts'

describe('Semaphore', () => {
  it('queues waiters until leave releases capacity', async () => {
    const semaphore = new Semaphore(1, 1, 1000)

    await semaphore.enter()
    const waiting = semaphore.enter()

    await Promise.resolve()

    expect(semaphore.queueLength).toBe(1)
    expect(semaphore.isEmpty).toBe(false)

    semaphore.leave()

    await expect(waiting).resolves.toBeUndefined()
    expect(semaphore.queueLength).toBe(0)
    expect(semaphore.isEmpty).toBe(true)
  })

  it('rejects when queue is full', async () => {
    const semaphore = new Semaphore(0, 1, 1000)

    const waiting = semaphore.enter()
    const rejected = semaphore.enter()

    await expect(rejected).rejects.toBeInstanceOf(SemaphoreError)

    semaphore.leave()
    await expect(waiting).resolves.toBeUndefined()
  })
})
