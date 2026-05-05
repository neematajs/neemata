import { describe, expect, it } from 'vitest'

import { NeemHostLifecycle } from '../../../packages/neem/src/internal/lifecycle.ts'

describe('NeemHostLifecycle', () => {
  it('tracks host lifecycle states', () => {
    const lifecycle = new NeemHostLifecycle()

    expect(lifecycle.getSnapshot()).toMatchObject({
      state: 'idle',
      revision: 0,
    })

    const starting = lifecycle.markStarting()
    expect(lifecycle.getSnapshot()).toMatchObject({
      state: 'starting',
      revision: starting.revision,
    })

    expect(lifecycle.markRunning(starting)).toBe(true)
    expect(lifecycle.getState()).toBe('running')

    const stopping = lifecycle.markStopping()
    expect(lifecycle.getState()).toBe('stopping')
    expect(lifecycle.markStopped(stopping)).toBe(true)
    expect(lifecycle.getState()).toBe('stopped')
  })

  it('ignores stale reload completions', () => {
    const lifecycle = new NeemHostLifecycle()
    lifecycle.markStarting()
    lifecycle.markRunning()

    const first = lifecycle.beginReload()
    const second = lifecycle.beginReload()

    expect(lifecycle.markRunning(first)).toBe(false)
    expect(lifecycle.getState()).toBe('reloading')
    expect(lifecycle.markRunning(second)).toBe(true)
    expect(lifecycle.getState()).toBe('running')
  })

  it('ignores stale reload failures', () => {
    const lifecycle = new NeemHostLifecycle()
    const first = lifecycle.beginReload()
    const second = lifecycle.beginReload()
    const error = new Error('stale failure')

    expect(lifecycle.markFailed(error, first)).toBe(false)
    expect(lifecycle.getSnapshot().lastError).toBeUndefined()
    expect(lifecycle.markFailed(error, second)).toBe(true)
    expect(lifecycle.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: error,
    })
  })
})
