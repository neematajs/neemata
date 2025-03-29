import { describe, expect, it } from 'vitest'
import { t } from '../../src/index.ts'
import * as runtime from '../../src/runtime.ts'

describe('Discriminated union type', () => {
  const schema = t.discriminatedUnion(
    'discriminator',
    t.object({
      discriminator: t.literal('a'),
      a: t.string(),
    }),
    t.object({
      discriminator: t.literal('b'),
      b: t.number(),
    }),
  )

  it('should correctly handle d-unions', () => {
    expect(runtime.check(schema, { discriminator: 'a', a: 'value' })).toBe(true)
    expect(runtime.check(schema, { discriminator: 'b', b: 1 })).toBe(true)

    expect(runtime.check(schema, {})).toBe(false)
    expect(runtime.check(schema, { discriminator: 'a' })).toBe(false)
    expect(runtime.check(schema, { discriminator: 'a', b: 1 })).toBe(false)
    expect(runtime.check(schema, { discriminator: 'b' })).toBe(false)
    expect(runtime.check(schema, { discriminator: 'b', a: '' })).toBe(false)
  })

  it('should correctly handle d-unions errors', () => {
    expect(runtime.errors(schema, { discriminator: 'a' })).toEqual([
      {
        path: '/a',
        value: undefined,
        message: expect.any(String),
      },
      {
        path: '/a',
        value: undefined,
        message: expect.any(String),
      },
    ])

    expect(runtime.errors(schema, { discriminator: 'a', a: 1 })).toEqual([
      {
        path: '/a',
        value: 1,
        message: expect.any(String),
      },
    ])

    expect(runtime.errors(schema, { discriminator: 'b' })).toEqual([
      {
        path: '/b',
        value: undefined,
        message: expect.any(String),
      },
      {
        path: '/b',
        value: undefined,
        message: expect.any(String),
      },
    ])

    expect(runtime.errors(schema, { discriminator: 'b', b: '' })).toEqual([
      {
        path: '/b',
        value: '',
        message: expect.any(String),
      },
    ])
  })
})
