import { describe, expect, it } from 'vitest'
import { t } from '../../src/index.ts'
import * as runtime from '../../src/runtime.ts'

describe('Enum types', () => {
  it('should correctly handle object enums', () => {
    const objectEnum = t.objectEnum({ a: 'a', b: 'b' })
    expect(runtime.check(objectEnum, 'a')).toBe(true)
    expect(runtime.check(objectEnum, 'b')).toBe(true)
    expect(runtime.check(objectEnum, 'c')).toBe(false)
  })

  it('should correctly handle TS native enums', () => {
    enum TestEnum {
      a = 'a',
      b = 'b',
    }
    const objectEnum = t.objectEnum(TestEnum)
    expect(runtime.check(objectEnum, 'a')).toBe(true)
    expect(runtime.check(objectEnum, 'b')).toBe(true)
    expect(runtime.check(objectEnum, 'c')).toBe(false)
  })

  it('should correctly handle array enums', () => {
    const arrayEnum = t.arrayEnum(['a', 'b'])
    expect(runtime.check(arrayEnum, 'a')).toBe(true)
    expect(runtime.check(arrayEnum, 'b')).toBe(true)
    expect(runtime.check(arrayEnum, 'c')).toBe(false)
  })
})
