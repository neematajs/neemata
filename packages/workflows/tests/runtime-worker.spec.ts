import { describe, expect, it } from 'vitest'

import { runWithConcurrency } from '../src/index.ts'

describe('workflow worker concurrency', () => {
  it('runs workers without exceeding concurrency', async () => {
    const items = [1, 2, 3, 4, 5]
    let active = 0
    let maxActive = 0

    await runWithConcurrency(items, 2, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    expect(maxActive).toBe(2)
  })

  it('rejects invalid concurrency', async () => {
    await expect(
      runWithConcurrency([1], 0, async () => {}),
    ).rejects.toThrow('Concurrency must be a positive integer')
  })
})
