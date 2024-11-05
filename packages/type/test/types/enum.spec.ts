import { describe, expect, it } from 'vitest'
import { runtime } from '../../src/compiler.ts'
import { t } from '../../src/index.ts'

describe('ObjectEnum type', () => {
  it('should correctly handle object enums', () => {
    const objectEnum = t.objectEnum({ a: 'a', b: 'b' })
    expect(runtime.check(objectEnum, 'a')).toBe(true)
    expect(runtime.check(objectEnum, 'b')).toBe(true)
    expect(runtime.check(objectEnum, 'c')).toBe(false)
  })
})

describe('ArrayEnum type', () => {
  it('should correctly handle array enums', () => {
    const arrayEnum = t.arrayEnum(['a', 'b'])
    expect(runtime.check(arrayEnum, 'a')).toBe(true)
    expect(runtime.check(arrayEnum, 'b')).toBe(true)
    expect(runtime.check(arrayEnum, 'c')).toBe(false)
  })
})
