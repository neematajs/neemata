import { describe, expect, it } from '@effect/vitest'

import { parseDurationMs, storedError } from '../src/model.ts'

describe('a duration', () => {
  it('is the milliseconds that were written, exactly', () => {
    // Multiplied as fractions, these two are off by a rounding.
    expect(parseDurationMs('1.001s')).toBe(1001)
    expect(parseDurationMs('4.35h')).toBe(15_660_000)
    expect(parseDurationMs('0.07s')).toBe(70)
    expect(parseDurationMs('1.1m')).toBe(66_000)
    expect(parseDurationMs('250ms')).toBe(250)
    expect(parseDurationMs('2d')).toBe(172_800_000)
  })

  it('stays a fraction when it is no whole number of milliseconds', () => {
    expect(parseDurationMs('1.5ms')).toBe(1.5)
    expect(parseDurationMs('0.0001s')).toBe(0.1)
  })

  it('is nothing when it is not one', () => {
    for (const text of ['', '1', 's', '1.s', '.5s', '-1s', '1 s', '1w']) {
      expect(parseDurationMs(text)).toBeUndefined()
    }
    expect(parseDurationMs(undefined)).toBeUndefined()
  })
})

describe('an error as it is stored', () => {
  it('keeps the fields of a value that reads as an error', () => {
    expect(
      storedError({
        name: 'GatewayError',
        message: 'declined',
        stack: 'GatewayError: declined\n    at charge',
        cause: { message: '503', code: 503 },
        retryable: false,
      }),
    ).toStrictEqual({
      name: 'GatewayError',
      message: 'declined',
      stack: 'GatewayError: declined\n    at charge',
      cause: { message: '503' },
    })
    // Only what a stored error can hold: fields of another type are left.
    expect(storedError({ name: 7, message: 'odd', stack: null })).toStrictEqual(
      { message: 'odd' },
    )
  })

  it('keeps an error and its causes, whatever each of them is', () => {
    const error = new TypeError('outer', {
      cause: { name: 'Wire', message: 'inner', cause: 'root' },
    })
    expect(storedError(error)).toStrictEqual({
      name: 'TypeError',
      message: 'outer',
      stack: error.stack,
      cause: { name: 'Wire', message: 'inner', cause: { message: 'root' } },
    })
  })

  it('is the text of anything else', () => {
    expect(storedError('plain')).toStrictEqual({ message: 'plain' })
    expect(storedError({ reason: 'declined' })).toStrictEqual({
      message: '[object Object]',
    })
    expect(storedError({ message: 404 })).toStrictEqual({
      message: '[object Object]',
    })
    expect(storedError(null)).toStrictEqual({ message: 'null' })
  })

  it('follows a chain of causes only so far, of errors or of what reads as one', () => {
    const depth = (stored: { cause?: object } | undefined): number =>
      stored ? 1 + depth(stored.cause) : 0
    const looped: { message: string; cause?: unknown } = { message: 'loop' }
    looped.cause = looped
    const chained = new Error('loop')
    chained.cause = chained

    expect(depth(storedError(looped))).toBe(6)
    expect(depth(storedError(chained))).toBe(6)
  })
})
