import { EventEmitter } from 'node:events'

import type { BuildOptions } from 'rolldown'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { watchConfigSignal } from '../../src/internal/services/config-signal.ts'

const rolldownMock = vi.hoisted(() => ({ watch: vi.fn() }))

vi.mock('rolldown', () => rolldownMock)

beforeEach(() => {
  rolldownMock.watch.mockReset()
})

describe('Neem config signal watcher', () => {
  it('can stay alive after an initial signal build error', async () => {
    const watcher = createWatcher()
    rolldownMock.watch.mockReturnValue(watcher)
    const onInvalidated = vi.fn()

    const signalWatcherPromise = watchConfigSignal({
      files: ['/app/neem.config.ts'],
      tolerateInitialError: true,
      onInvalidated,
    })
    watcher.emit('event', {
      code: 'ERROR',
      error: new Error('config is broken'),
    })

    await expect(signalWatcherPromise).resolves.toBe(watcher)
    expect(onInvalidated).not.toHaveBeenCalled()
  })

  it('emits invalidation when a watched rebuild fails after ready', async () => {
    const watcher = createWatcher()
    rolldownMock.watch.mockReturnValue(watcher)
    const onInvalidated = vi.fn()

    const signalWatcherPromise = watchConfigSignal({
      files: ['/app/neem.config.ts', '/app/api.runtime.ts'],
      onInvalidated,
    })
    watcher.emit('event', { code: 'END' })
    await signalWatcherPromise

    watcher.emit('event', {
      code: 'ERROR',
      error: new Error('config is broken'),
    })

    expect(onInvalidated).toHaveBeenCalledTimes(1)
    const options = rolldownMock.watch.mock.calls[0]?.[0] as BuildOptions
    expect(options.input).toEqual([
      '/app/neem.config.ts',
      '/app/api.runtime.ts',
    ])
    expect(options.watch).toMatchObject({ skipWrite: true })
  })
})

function createWatcher(): EventEmitter & { close: () => Promise<void> } {
  const watcher = new EventEmitter() as EventEmitter & {
    close: () => Promise<void>
  }
  watcher.close = vi.fn(async () => {})
  return watcher
}
