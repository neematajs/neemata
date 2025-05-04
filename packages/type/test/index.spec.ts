import { describe, expect, it } from 'vitest'
import { t } from '../src/index.ts'

describe('Simple type', () => {
  const schema = t.object({
    prop1: t.string(),
    prop2: t.number(),
    prop3: t.boolean(),
    prop4: t.date(),
    prop5: t.integer(),
    prop6: t.literal('a'),
    prop7: t.enum(['a', 'b', 'c'] as const),
    prop8: t.enum({
      a: 'A',
      b: 'B',
      c: 'C',
    } as const),
    prop9: t.tuple([t.string(), t.number()]),
  })

  it('should decode', () => {
    const value = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: '2021-01-01',
      prop5: 42,
      prop6: 'a' as const,
      prop7: 'a' as const,
      prop8: 'A' as const,
      prop9: ['string', 42] as [string, number],
    }

    schema.decode(value)
  })

  it('should encode', () => {
    const value = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: new Date('2021-01-01'),
      prop5: 42,
      prop6: 'a' as const,
      prop7: 'a' as const,
      prop8: 'A' as const,
      prop9: ['string', 42] as [string, number],
    }

    schema.encode(value)
  })
})

describe('Simple type with defaults', () => {
  const schema = t.object({
    prop1: t.string().default('default'),
    prop2: t.number().default(42),
    prop3: t.boolean().default(true),
    prop4: t.date().default(new Date('2021-01-01')),
    prop5: t.integer().default(42),
    prop6: t.literal('a').default('a'),
    prop7: t.enum(['a', 'b', 'c'] as const).default('a'),
    prop8: t
      .enum({
        a: 'A',
        b: 'B',
        c: 'C',
      } as const)
      .default('A'),
    prop9: t
      .array(
        t
          .object({
            prop1: t
              .array(
                t
                  .object({
                    prop1: t.string().default('default'),
                    prop2: t.number().default(42),
                  })
                  .default({}),
              )
              .default([{}]),
          })
          .default({}),
      )
      .default([{}]),
  })

  it('should decode', () => {
    const value = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: '2021-01-01',
      prop5: 42,
      prop6: 'a' as const,
      prop7: 'a' as const,
      prop8: 'A' as const,
    }

    const result = schema.decode(value)
    expect(result.prop9).toBeDefined()
  })

  it('should encode', () => {
    const value = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: new Date('2021-01-01'),
      prop5: 42,
      prop6: 'a' as const,
      prop7: 'a' as const,
      prop8: 'A' as const,
    }

    const result = schema.encode(value)
    expect(result.prop9).toBeDefined()
  })
})

describe('Complex type', () => {
  const schema = t.object({
    prop1: t.string(),
    prop2: t.number(),
    prop3: t.boolean(),
    prop4: t.array(
      t.object({
        prop1: t.literal('a'),
        prop2: t.date(),
        prop3: t.record(t.string(), t.number()),
      }),
    ),
    prop5: t.object({
      prop1: t.string(),
      prop2: t.integer(),
      prop3: t.enum(['a', 'b', 'c'] as const),
      prop4: t.enum({
        a: 'A',
        b: 'B',
        c: 'C',
      } as const),
    }),
    prop6: t.merge(
      t.object({ prop1: t.string() }),
      t.object({ prop2: t.number() }),
    ),
    prop7: t.extend(t.object({ prop1: t.string() }), {
      prop2: t.number(),
    }),
    prop8: t.omit(t.object({ prop1: t.string(), prop2: t.number() }), {
      prop2: true,
    }),
    prop9: t.partial(t.object({ prop1: t.string(), prop2: t.number() })),
    prop10: t.pick(t.object({ prop1: t.string(), prop2: t.number() }), {
      prop1: true,
    }),
    prop11: t.keyof(t.object({ prop1: t.string(), prop2: t.number() })),
    prop12: t.or(
      t.object({ prop1: t.string() }),
      t.object({ prop2: t.number() }),
    ),
    prop13: t.and(
      t.object({ prop1: t.string() }),
      t.object({ prop2: t.number() }),
    ),
    prop14: t.discriminatedUnion(
      'type',
      t.object({ type: t.literal('a'), prop1: t.string() }),
      t.object({ type: t.literal('b'), prop2: t.number() }),
    ),
  })

  it('should decode', () => {
    const value = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: [
        {
          prop1: 'a' as const,
          prop2: '2021-01-01',
          prop3: {
            key1: 42,
            key2: 42,
          },
        },
      ],
      prop5: {
        prop1: 'string',
        prop2: 42,
        prop3: 'a' as const,
        prop4: 'A' as const,
      },
      prop6: {
        prop1: 'string',
        prop2: 42,
      },
      prop7: {
        prop1: 'string',
        prop2: 42,
      },
      prop8: {
        prop1: 'string',
      },
      prop9: {
        prop1: 'string',
      },
      prop10: {
        prop1: 'string',
      },
      prop11: 'prop1' as const,
      prop12: {
        prop1: 'string',
      },
      prop13: {
        prop1: 'string',
        prop2: 42,
      },
      prop14: {
        type: 'a' as const,
        prop1: 'string',
      },
    }

    schema.decode(value)
  })

  it('should encode', () => {
    const value = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: [
        {
          prop1: 'a' as const,
          prop2: new Date('2021-01-01'),
          prop3: {
            key1: 42,
            key2: 42,
          },
        },
      ],
      prop5: {
        prop1: 'string',
        prop2: 42,
        prop3: 'a' as const,
        prop4: 'A' as const,
      },
      prop6: {
        prop1: 'string',
        prop2: 42,
      },
      prop7: {
        prop1: 'string',
        prop2: 42,
      },
      prop8: {
        prop1: 'string',
      },
      prop9: {
        prop1: 'string',
      },
      prop10: {
        prop1: 'string',
      },
      prop11: 'prop1' as const,
      prop12: {
        prop1: 'string',
      },
      prop13: {
        prop1: 'string',
        prop2: 42,
      },
      prop14: {
        type: 'a' as const,
        prop1: 'string',
      },
    }

    schema.encode(value)
  })
})
