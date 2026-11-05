import * as Effect from 'effect/Effect'
import { pino, type Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { callHook } from '../../src/internal/context.ts'
import { createHostHooks, type HostHooks } from '../../src/internal/hooks.ts'
const callHostHook = (
  hooks: HostHooks,
  logger: Logger,
  name: 'dispose' | 'server:stop',
  event: { mode: 'development' | 'production' },
) => Effect.runPromise(hooks.call(logger, name, event))

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

describe('callHook', () => {
  it('stops waiting at the timeout for a hook stuck in uninterruptible cleanup', async () => {
    const hooks = createHostHooks()
    // An Effect hook whose cleanup never ends; interrupting it cannot finish.
    hooks.hook('server:stop', () =>
      Effect.never.pipe(Effect.ensuring(Effect.never)),
    )

    const startedAt = Date.now()
    await expect(
      Effect.runPromise(
        callHook({ hooks, logger, timeout: 50 }, 'server:stop', {
          mode: 'production',
        }),
      ),
    ).rejects.toThrow('Neem hook [server:stop] did not finish within 50ms')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})
