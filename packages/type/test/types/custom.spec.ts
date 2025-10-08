import { describe, expect, it } from 'vitest'

import { t } from '../../src/index.ts'

describe('CustomType - Date', () => {
  const dateType = t.date()

  describe('decode (string -> Date)', () => {
    it('should decode ISO date string to Date object', () => {
      const input = '2021-01-01'
      const result = dateType.decode(input)

      expect(result).toBeInstanceOf(Date)
      expect(result.toISOString()).toBe('2021-01-01T00:00:00.000Z')
    })

    it('should decode ISO datetime string to Date object', () => {
      const input = '2021-01-01T12:30:45.123Z'
      const result = dateType.decode(input)

      expect(result).toBeInstanceOf(Date)
      expect(result.toISOString()).toBe(input)
    })

    it('should reject invalid date string', () => {
      expect(() => dateType.decode('not-a-date')).toThrow()
    })
  })

  describe('encode (Date -> string)', () => {
    it('should encode Date object to ISO string', () => {
      const input = new Date('2021-01-01T12:30:45.123Z')
      const result = dateType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('2021-01-01T12:30:45.123Z')
    })
  })
})

describe('CustomType - BigInt', () => {
  const bigIntType = t.bigInt()

  describe('decode (string -> bigint)', () => {
    it('should decode numeric string to bigint', () => {
      const input = '123456789012345678901234567890'
      const result = bigIntType.decode(input)

      expect(typeof result).toBe('bigint')
      expect(result).toBe(123456789012345678901234567890n)
    })

    it('should decode negative numeric string to bigint', () => {
      const input = '-987654321098765432109876543210'
      const result = bigIntType.decode(input)

      expect(typeof result).toBe('bigint')
      expect(result).toBe(-987654321098765432109876543210n)
    })

    it('should reject non-numeric string', () => {
      expect(() => bigIntType.decode('not-a-number')).toThrow()
    })

    it('should reject string with decimals', () => {
      expect(() => bigIntType.decode('123.456')).toThrow()
    })
  })

  describe('encode (bigint -> string)', () => {
    it('should encode bigint to numeric string', () => {
      const input = 123456789012345678901234567890n
      const result = bigIntType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('123456789012345678901234567890')
    })

    it('should encode negative bigint to numeric string', () => {
      const input = -987654321098765432109876543210n
      const result = bigIntType.encode(input)

      expect(typeof result).toBe('string')
      expect(result).toBe('-987654321098765432109876543210')
    })
  })
})

describe('CustomType - Integration in Objects', () => {
  const schema = t.object({
    id: t.bigInt(),
    createdAt: t.date(),
    name: t.string(),
  })

  describe('decode', () => {
    it('should decode object with custom types', () => {
      const input = {
        id: '999999999999999999',
        createdAt: '2021-01-01T00:00:00.000Z',
        name: 'Test',
      }

      const result = schema.decode(input)

      expect(typeof result.id).toBe('bigint')
      expect(result.id).toBe(999999999999999999n)
      expect(result.createdAt).toBeInstanceOf(Date)
      expect(result.createdAt.toISOString()).toBe('2021-01-01T00:00:00.000Z')
      expect(result.name).toBe('Test')
    })

    it('should reject invalid custom type values', () => {
      const input = {
        id: 'not-a-number',
        createdAt: '2021-01-01T00:00:00.000Z',
        name: 'Test',
      }

      expect(() => schema.decode(input)).toThrow()
    })
  })

  describe('encode', () => {
    it('should encode object with custom types', () => {
      const input = {
        id: 999999999999999999n,
        createdAt: new Date('2021-01-01T00:00:00.000Z'),
        name: 'Test',
      }

      const result = schema.encode(input)

      expect(typeof result.id).toBe('string')
      expect(result.id).toBe('999999999999999999')
      expect(typeof result.createdAt).toBe('string')
      expect(result.createdAt).toBe('2021-01-01T00:00:00.000Z')
      expect(result.name).toBe('Test')
    })
  })
})

describe('CustomType - Edge Cases', () => {
  describe('undefined handling', () => {
    it('should handle undefined in decode', () => {
      const dateType = t.date().optional()
      expect(() => dateType.decode(undefined)).not.toThrow()
    })
    it('should handle undefined in encode', () => {
      const dateType = t.date().optional()
      expect(() => dateType.encode(undefined)).not.toThrow()
    })
  })

  describe('with optional', () => {
    const optionalDate = t.date().optional()

    it('should handle undefined with optional in decode', () => {
      const result = optionalDate.decode(undefined)
      expect(result).toBeUndefined()
    })

    it('should decode valid value with optional', () => {
      const result = optionalDate.decode('2021-01-01')
      expect(result).toBeInstanceOf(Date)
    })
  })

  describe('with nullable', () => {
    const nullableDate = t.date().nullable()

    it('should handle null with nullable in decode', () => {
      const result = nullableDate.decode(null)
      expect(result).toBeNull()
    })

    it('should decode valid value with nullable', () => {
      const result = nullableDate.decode('2021-01-01')
      expect(result).toBeInstanceOf(Date)
    })
  })

  describe('with default', () => {
    const defaultDate = new Date('2021-01-01T00:00:00.000Z')
    const dateWithDefault = t.date().default(defaultDate)

    it('should use default when undefined in decode', () => {
      const result = dateWithDefault.decode(undefined)
      expect(result).toEqual(defaultDate)
    })

    it('should decode provided value instead of default', () => {
      const result = dateWithDefault.decode('2022-06-15T00:00:00.000Z')
      expect(result.toISOString()).toBe('2022-06-15T00:00:00.000Z')
    })
  })
})
