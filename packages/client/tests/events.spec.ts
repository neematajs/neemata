import { describe, expect, it, vi } from 'vitest'

import { EventEmitter, once } from '../src/events.ts'

describe('EventEmitter', () => {
  it('invokes once listeners only once', () => {
    const emitter = new EventEmitter<{ ping: [value: number] }>()
    const listener = vi.fn()

    emitter.once('ping', listener)

    emitter.emit('ping', 1)
    emitter.emit('ping', 2)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(1)
  })

  it('removes listeners from the requested event only', () => {
    const emitter = new EventEmitter<{
      ping: [value: number]
      pong: [value: number]
    }>()
    const listener = vi.fn()

    emitter.on('ping', listener)
    emitter.on('pong', listener)

    emitter.off('ping', listener)

    emitter.emit('ping', 1)
    emitter.emit('pong', 2)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(2)
  })

  it('cleans up once listeners after they fire', () => {
    const emitter = new EventEmitter<{
      ping: [value: number]
      pong: [value: number]
    }>()
    const listener = vi.fn()

    emitter.on('pong', listener)
    emitter.once('ping', listener)

    emitter.emit('ping', 1)
    emitter.off('pong', listener)
    emitter.emit('pong', 2)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(1)
  })

  it('cleans up signaled listeners after abort', () => {
    const emitter = new EventEmitter<{
      ping: [value: number]
      pong: [value: number]
    }>()
    const listener = vi.fn()
    const controller = new AbortController()

    emitter.on('pong', listener)
    emitter.on('ping', listener, { signal: controller.signal })

    controller.abort('stop')
    emitter.off('pong', listener)
    emitter.emit('ping', 1)
    emitter.emit('pong', 2)

    expect(listener).not.toHaveBeenCalled()
  })

  it('returns an idempotent disposer from on', () => {
    const emitter = new EventEmitter<{ ping: [value: number] }>()
    const listener = vi.fn()

    const dispose = emitter.on('ping', listener)

    dispose()
    dispose()
    emitter.emit('ping', 1)

    expect(listener).not.toHaveBeenCalled()
  })

  it('supports duplicate registrations and removes them one at a time', () => {
    const emitter = new EventEmitter<{ ping: [value: number] }>()
    const listener = vi.fn()

    emitter.on('ping', listener)
    emitter.on('ping', listener)

    emitter.emit('ping', 1)
    expect(listener).toHaveBeenCalledTimes(2)

    emitter.off('ping', listener)
    emitter.emit('ping', 2)

    expect(listener).toHaveBeenCalledTimes(3)
    expect(listener).toHaveBeenLastCalledWith(2)
  })

  it('aborts only the signaled registration when the same listener is attached twice', () => {
    const emitter = new EventEmitter<{ ping: [value: number] }>()
    const listener = vi.fn()
    const controller = new AbortController()

    emitter.on('ping', listener)
    emitter.on('ping', listener, { signal: controller.signal })

    controller.abort('stop')
    emitter.emit('ping', 1)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(1)
  })

  it('resolves the exported once helper with the emitted arguments', async () => {
    const emitter = new EventEmitter<{ ping: [value: number, label: string] }>()

    const result = once(emitter, 'ping')

    emitter.emit('ping', 7, 'ready')

    await expect(result).resolves.toEqual([7, 'ready'])
  })
})
