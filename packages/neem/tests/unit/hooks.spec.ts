import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import {
  callHostHook,
  createHostHooks,
} from '../../src/internal/plugins/hooks.ts'

const logger = pino({ enabled: false })

describe('callHostHook', () => {
  it('runs every callback after one fails and rejects with its error', async () => {
    const hooks = createHostHooks()
    const failure = new Error('first plugin dispose failed')
    const first = vi.fn(() => {
      throw failure
    })
    const second = vi.fn(async () => {})
    hooks.hook('dispose', first)
    hooks.hook('dispose', second)

    await expect(
      callHostHook(hooks, logger, 'dispose', { mode: 'development' }),
    ).rejects.toBe(failure)

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('reports every failing callback together', async () => {
    const hooks = createHostHooks()
    const last = vi.fn()
    hooks.hook('server:stop', () => {
      throw new Error('proxy plugin failed')
    })
    hooks.hook('server:stop', async () => {
      throw new Error('metrics plugin failed')
    })
    hooks.hook('server:stop', last)

    const error = await callHostHook(hooks, logger, 'server:stop', {
      mode: 'production',
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toMatchObject({
      message:
        'Neem hook [server:stop] failed: proxy plugin failed; metrics plugin failed',
    })
    expect(last).toHaveBeenCalledOnce()
  })
})
