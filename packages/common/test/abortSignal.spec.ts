import { describe, expect, it } from 'vitest'

import { anyAbortSignal } from '../src/abortSignal.ts'

describe('anyAbortSignal', () => {
  it('throws when no signals are provided', () => {
    expect(() => anyAbortSignal()).toThrow('No AbortSignals provided')
  })

  it('returns the same signal when one signal is provided', () => {
    const controller = new AbortController()

    expect(anyAbortSignal(controller.signal)).toBe(controller.signal)
  })

  it('returns already aborted signal directly', () => {
    const controller = new AbortController()
    const reason = new Error('already aborted')
    controller.abort(reason)

    expect(anyAbortSignal(controller.signal)).toBe(controller.signal)
  })

  it('aborts combined signal when any source aborts and forwards reason', () => {
    const first = new AbortController()
    const second = new AbortController()

    const combined = anyAbortSignal(first.signal, second.signal)

    const reason = new Error('boom')
    second.abort(reason)

    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe(reason)
  })

  it('ignores undefined signals', () => {
    const controller = new AbortController()

    const combined = anyAbortSignal(undefined, controller.signal, undefined)

    controller.abort('ok')

    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('ok')
  })
})
