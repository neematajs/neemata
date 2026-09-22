import { describe, expect, it } from 'vitest'

import {
  decodeOrderedRecord,
  decodeRecord,
} from '../src/adapters/redis/store.ts'

describe('Redis store hash decoding', () => {
  describe.each([
    { name: 'decodeRecord', decode: decodeRecord },
    { name: 'decodeOrderedRecord', decode: decodeOrderedRecord },
  ])('$name', ({ decode }) => {
    it.each([{ keys: ['__proto__'] }, { keys: [] }])(
      'preserves an own __proto__ hash field with ordered keys $keys',
      ({ keys }) => {
        const values = { ['__proto__']: '{"value":"kept"}', ok: '"ok"' }
        const decoded = decode(values, keys)

        expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
        expect(decoded.__proto__).toEqual({ value: 'kept' })
        expect(Object.getPrototypeOf(decoded)).toBeNull()
        expect(decoded.ok).toBe('ok')
        expect(Object.keys(decoded)).toEqual(['__proto__', 'ok'])
      },
    )

    it('ignores inherited hash fields', () => {
      const values: Record<string, string> = Object.create({ inherited: '1' })
      values.own = '2'
      const decoded = decode(values, ['inherited', 'own'])

      expect(Object.keys(decoded)).toEqual(['own'])
      expect(decoded.own).toBe(2)
      expect(Object.getPrototypeOf(decoded)).toBeNull()
    })
  })
})
