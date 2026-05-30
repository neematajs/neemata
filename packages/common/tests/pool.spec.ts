import { describe, expect, it } from 'vitest'

import { Pool, PoolError } from '../src/pool.ts'

describe('Pool', () => {
  it('returns free items in order', async () => {
    const pool = new Pool<string>()
    pool.add('first')
    pool.add('second')

    await expect(pool.next()).resolves.toBe('first')
    await expect(pool.next()).resolves.toBe('second')
  })

  it('waits for captured item release', async () => {
    const pool = new Pool<string>()
    pool.add('item')

    const captured = await pool.capture()
    const next = pool.next()
    let resolved = false
    next.then(() => {
      resolved = true
    })

    await Promise.resolve()

    expect(captured).toBe('item')
    expect(resolved).toBe(false)

    pool.release(captured)

    await expect(next).resolves.toBe('item')
    expect(resolved).toBe(true)
  })

  it('rejects duplicate items and empty pools', async () => {
    const pool = new Pool<string>()

    await expect(pool.next()).rejects.toBeInstanceOf(PoolError)

    pool.add('item')
    expect(() => pool.add('item')).toThrow(PoolError)
  })
})
