import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { decodeNumber, encodeNumber } from '../../src/common/binary.ts'

describe('decodeNumber', () => {
  it('decodes values encoded by encodeNumber', () => {
    expect(decodeNumber(encodeNumber(42, 'Uint32'), 'Uint32')).toBe(42)
    expect(decodeNumber(encodeNumber(-7, 'Int16'), 'Int16')).toBe(-7)
  })

  it('reads a subarray view relative to its own offset', () => {
    const backing = Buffer.from([0xff, 0xff, 0x2a, 0x00, 0x00, 0x00, 0xff])
    const view = backing.subarray(2, 6)
    expect(decodeNumber(view, 'Uint32')).toBe(42)
  })

  it('throws instead of reading neighboring bytes past the view bounds', () => {
    const backing = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
    // the backing buffer has enough bytes, but the view does not
    const view = backing.subarray(0, 2)
    expect(() => decodeNumber(view, 'Uint32')).toThrow(RangeError)
    expect(() => decodeNumber(view, 'Uint8', 2)).toThrow(RangeError)
  })
})
