import { describe, expect, it } from 'vitest'

import { parseDurationMs } from '../src/runtime/duration.ts'

describe('workflow runtime duration parser', () => {
  it.each([
    ['0ms', 0],
    ['15ms', 15],
    ['1.5s', 1_500],
    ['2m', 120_000],
    ['3h', 10_800_000],
    ['4d', 345_600_000],
  ])('parses %s', (duration, expectedMs) => {
    expect(parseDurationMs(duration)).toBe(expectedMs)
  })

  it.each([
    undefined,
    '',
    '10',
    'ms',
    '1w',
    '-1s',
    '1 s',
    'Infinitys',
    'NaNms',
  ])('rejects invalid duration %s', (duration) => {
    expect(parseDurationMs(duration)).toBeUndefined()
  })
})
