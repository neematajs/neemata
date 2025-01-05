import { describe, expect, it } from 'vitest'
import { runtime } from '../../src/compiler.ts'
import { t } from '../../src/index.ts'

describe('Record type', () => {
  it('should correctly resolve key as arrayEnum', () => {
    const arrayEnum = t.arrayEnum(['a'])
    const recondType = t.record(arrayEnum, t.any())
    expect(runtime.check(recondType, { a: 'test' })).toBe(true)
  })

  it('should correctly resolve key as objectEnum', () => {
    const objectEnum = t.objectEnum({ a: 'a' as const })
    const recondType = t.record(objectEnum, t.any())
    expect(runtime.check(recondType, { a: 'test' })).toBe(true)
  })
})
