import { describe, expect, it } from 'vitest'
import { t } from '../../src/index.ts'
import * as runtime from '../../src/runtime.ts'

describe('Object type', () => {
  it('should correctly handle object', () => {
    const schema1 = t.object({
      value: t.string(),
    })
    expect(runtime.check(schema1, { value: 'test' })).toBe(true)

    const schema2 = t.object({
      value: t.string().optional(),
    })
    expect(runtime.check(schema2, { value: undefined })).toBe(true)

    const schema3 = t.object({
      value: t.string().nullable(),
    })
    expect(runtime.check(schema3, { value: null })).toBe(true)

    const schema4 = t.object({
      value: t.string().nullish(),
    })
    expect(runtime.check(schema4, { value: null })).toBe(true)
    expect(runtime.check(schema4, { value: undefined })).toBe(true)

    const schema5 = t.object({
      value: t.string().optional().default('test'),
    })
    expect(runtime.check(schema5, { value: undefined })).toBe(true)

    const schema6 = t.object({
      value: t.string().nullable().default('test'),
    })
    expect(runtime.check(schema6, { value: null })).toBe(true)
    expect(runtime.check(schema6, { value: undefined })).toBe(true)

    const schema7 = t.object({
      value: t.string().nullish().default('test'),
    })
    expect(runtime.check(schema7, { value: null })).toBe(true)
    expect(runtime.check(schema7, { value: undefined })).toBe(true)

    const schema8 = t.object({
      value: t.string().default('test'),
    })
    expect(runtime.check(schema8, { value: undefined })).toBe(true)
  })
})
