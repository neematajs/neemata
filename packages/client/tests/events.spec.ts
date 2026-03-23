import { describe, expect, it, vi } from 'vitest'

import { EventEmitter } from '../src/events.ts'

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
})
