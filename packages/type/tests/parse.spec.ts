import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { core } from 'zod/mini'
import {
  isSchema,
  isWireSchemaCodec,
  SchemaValidationError,
  validateSchema,
} from '@nmtjs/common/schema'
import { ProtocolBlob } from '@nmtjs/protocol'
import { Temporal } from 'temporal-polyfill'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { compile, number, string } from 'zod/mini'

import { blobType, t } from '../src/index.ts'
import { plainDate } from '../src/temporal/polyfill.ts'

const instant = new Date('2026-09-08T00:00:00.000Z')

describe('runtime schemas', () => {
  it('validates decoded values from unknown without calling wire transforms', () => {
    const decode = vi.fn(Number)
    const encode = vi.fn(String)
    const amount = t.custom({
      decode: { type: number(), transform: decode },
      encode: { type: string(), transform: encode },
    })
    const schema = t.object({ amount, at: t.date(), id: t.bigInt() })
    const value: unknown = { amount: 42, at: instant, id: 42n, extra: true }
    const result = schema.parse(value)
    expect(result).toEqual({ amount: 42, at: instant, id: 42n })
    expect(result).not.toBe(value)
    expect(decode).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
    expectTypeOf(result).toEqualTypeOf<{
      amount: number
      at: Date
      id: bigint
    }>()
    expect(() =>
      schema.parse({ amount: '42', at: instant.toISOString(), id: '42' }),
    ).toThrow(t.NeemataTypeError)
    expect(() =>
      schema.parse({ amount: 42, at: new Date(Number.NaN), id: 42n }),
    ).toThrow(t.NeemataTypeError)
    expect(() =>
      schema.parse({ amount: Number.NaN, at: instant, id: 42n }),
    ).toThrow(t.NeemataTypeError)
  })

  it('retains runtime defaults through nested objects and collections', () => {
    const decode = vi.fn(Number)
    const encode = vi.fn(String)
    const amount = t
      .custom({
        decode: { type: number(), transform: decode },
        encode: { type: string(), transform: encode },
      })
      .default(42)
    const schema = t.object({
      at: t.date().default(instant),
      id: t.bigInt().default(1n),
      items: t.array(t.object({ amount })).default([{}]),
      nested: t.object({ at: t.date().default(instant) }).default({}),
    })
    decode.mockClear()
    encode.mockClear()
    expect(schema.parse({})).toEqual({
      at: instant,
      id: 1n,
      items: [{ amount: 42 }],
      nested: { at: instant },
    })
    expect(decode).not.toHaveBeenCalled()
    expect(encode).not.toHaveBeenCalled()
    expect(schema.parse({ items: [{ amount: 7 }] }).items).toEqual([
      { amount: 7 },
    ])
    expectTypeOf<
      StandardSchemaV1.InferInput<typeof schema.parse>
    >().toEqualTypeOf<{
      at?: Date
      id?: bigint
      items?: { amount?: number }[]
      nested?: { at?: Date }
    }>()
    expectTypeOf<
      StandardSchemaV1.InferOutput<typeof schema.parse>
    >().toEqualTypeOf<{
      at: Date
      id: bigint
      items: { amount: number }[]
      nested: { at: Date }
    }>()
  })

  it('preserves optional, nullable, and default wrapper order', () => {
    expect(t.date().optional().parse(undefined)).toBeUndefined()
    expect(t.date().nullable().parse(null)).toBeNull()
    expect(t.date().nullish().parse(undefined)).toBeUndefined()
    expect(t.date().nullish().parse(null)).toBeNull()
    expect(t.date().default(instant).parse(undefined)).toEqual(instant)
    expect(t.date().default(instant).optional().parse(undefined)).toEqual(
      instant,
    )
    expect(t.date().optional().default(instant).parse(undefined)).toEqual(
      instant,
    )
    expect(() => t.date().parse(undefined)).toThrow(t.NeemataTypeError)
  })

  it('runs shared custom constraints once on each path', () => {
    const shared = vi.fn((value: number, ctx: core.$RefinementCtx<number>) => {
      if (value < 0) ctx.addIssue('Must be nonnegative')
    })
    const schema = t.custom({
      decode: { type: number(), transform: Number },
      encode: { type: string(), transform: String },
      validation: shared,
    })
    expect(schema.parse(42)).toBe(42)
    expect(shared).toHaveBeenCalledTimes(1)
    expect(schema.decode('42')).toBe(42)
    expect(shared).toHaveBeenCalledTimes(2)
    expect(schema.encode(42)).toBe('42')
    expect(shared).toHaveBeenCalledTimes(3)
    expect(() => schema.parse(-1)).toThrow('Must be nonnegative')
    expect(() => schema.decode('-1')).toThrow('Must be nonnegative')
    expect(() => schema.encode(-1)).toThrow('Must be nonnegative')
  })

  it('keeps direction-specific custom constraints separate', () => {
    const schema = t.custom({
      decode: { type: number(), transform: Number },
      encode: { type: string(), transform: String },
      validation: {
        runtime(value, ctx) {
          if (!Number.isInteger(value)) ctx.addIssue('Integer required')
        },
        decode(value, ctx) {
          if (value < 0) ctx.addIssue('Incoming must be positive')
        },
        encode(value, ctx) {
          if (value > 10) ctx.addIssue('Outgoing maximum is ten')
        },
      },
    })
    expect(schema.parse(-1)).toBe(-1)
    expect(schema.parse(11)).toBe(11)
    expect(schema.encode(-1)).toBe('-1')
    expect(schema.decode('11')).toBe(11)
    expect(() => schema.decode('-1')).toThrow('Incoming must be positive')
    expect(() => schema.encode(11)).toThrow('Outgoing maximum is ten')
    expect(() => schema.parse(1.5)).toThrow('Integer required')
    expect(() => schema.decode('1.5')).toThrow('Integer required')
    expect(() => schema.encode(1.5)).toThrow('Integer required')
  })

  it('validates a supplied runtime schema and leaves reused schemas independent', () => {
    const runtimeType = number()
    const first = t
      .custom({
        decode: { type: runtimeType, transform: Number },
        encode: { type: string(), transform: String },
        validation(value, ctx) {
          if (value < 0) ctx.addIssue('Must be positive')
        },
      })
      .title('First')
    const second = t.custom({
      decode: { type: runtimeType, transform: Number },
      encode: { type: string(), transform: String },
    })
    expect(() => first.parse(-1)).toThrow('Must be positive')
    expect(second.parse(-1)).toBe(-1)
    expect(runtimeType.parse(-1)).toBe(-1)
    expect(() => first.parse('42')).toThrow(t.NeemataTypeError)
    expect(
      second.parse['~standard'].jsonSchema.output({ target: 'draft-07' }),
    ).not.toHaveProperty('title')
    expect(() => {
      t.custom({
        // @ts-expect-error Runtime validation cannot be inferred from a transform's return type.
        decode: { transform: Number },
        encode: { type: string(), transform: String },
      })
    }).toThrow('Custom types require decode.type')
    expect(() => {
      t.custom({
        decode: { type: number(), transform: Number },
        // @ts-expect-error Wire validation requires an explicit output schema too.
        encode: { transform: String },
      })
    }).toThrow('Custom types require encode.type')
  })

  it('supports Standard Schema validation with async runtime constraints', async () => {
    const schema = t.custom({
      decode: { type: number(), transform: Number },
      encode: { type: string(), transform: String },
      async validation(value, ctx) {
        await Promise.resolve()
        if (value < 0) ctx.addIssue('Must be positive')
      },
    })
    expect(isSchema(schema.parse)).toBe(true)
    expect(isWireSchemaCodec(schema.parse)).toBe(false)
    expect(isSchema(schema)).toBe(false)
    expect(isWireSchemaCodec(schema)).toBe(true)
    await expect(validateSchema(schema.parse, 42)).resolves.toBe(42)
    await expect(validateSchema(schema.parse, -1)).rejects.toBeInstanceOf(
      SchemaValidationError,
    )
    await expect(schema.parse['~standard'].validate(-1)).resolves.toMatchObject(
      { issues: [{ message: 'Must be positive' }] },
    )
    expect(() => schema.parse(42)).toThrow()
  })

  it('preserves nested issue paths and parse context', async () => {
    const schema = t.object({ at: t.date() })
    expect(
      await schema.parse['~standard'].validate({ at: 'bad' }),
    ).toMatchObject({ issues: [{ path: ['at'] }] })
    expect(() =>
      t.number().parse('bad', { error: () => 'Runtime number required' }),
    ).toThrow('Runtime number required')
  })

  it('composes runtime parsers through every collection type', () => {
    expect(t.array(t.date()).min(1).parse([instant])).toEqual([instant])
    expect(() => t.array(t.date()).min(1).parse([])).toThrow(t.NeemataTypeError)
    expect(t.tuple([t.date(), t.bigInt()]).parse([instant, 1n])).toEqual([
      instant,
      1n,
    ])
    expect(t.tuple([t.date()], t.bigInt()).parse([instant, 1n, 2n])).toEqual([
      instant,
      1n,
      2n,
    ])
    expect(t.record(t.string(), t.date()).parse({ at: instant })).toEqual({
      at: instant,
    })
    const record = t.record(t.enum(['first', 'second'] as const), t.date())
    expect(record.parse({ first: instant, second: instant })).toEqual({
      first: instant,
      second: instant,
    })
    expect(() => record.parse({ first: instant })).toThrow(t.NeemataTypeError)
    expect(
      t.looseObject({ at: t.date() }).parse({ at: instant, extra: true }),
    ).toEqual({ at: instant, extra: true })
    expect(t.union(t.date(), t.bigInt()).parse(1n)).toBe(1n)
    expect(
      t
        .intersection(t.object({ at: t.date() }), t.object({ id: t.bigInt() }))
        .parse({ at: instant, id: 1n }),
    ).toEqual({ at: instant, id: 1n })
    const tagged = t.discriminatedUnion(
      'kind',
      t.object({ kind: t.literal('date'), value: t.date() }),
      t.object({ kind: t.literal('bigint'), value: t.bigInt() }),
    )
    expect(tagged.parse({ kind: 'date', value: instant })).toEqual({
      kind: 'date',
      value: instant,
    })
    expect(() => tagged.parse({ kind: 'date', value: 1n })).toThrow(
      t.NeemataTypeError,
    )
    expectTypeOf<ReturnType<typeof tagged.parse>>().toEqualTypeOf<
      { kind: 'date'; value: Date } | { kind: 'bigint'; value: bigint }
    >()
    expectTypeOf<ReturnType<typeof record.parse>>().toEqualTypeOf<{
      first: Date
      second: Date
    }>()
  })

  it('validates temporal and blob instances without serializing them', () => {
    const date = Temporal.PlainDate.from('2026-09-08')
    expect(plainDate().parse(date)).toBe(date)
    expect(() => plainDate().parse('2026-09-08')).toThrow(t.NeemataTypeError)
    const file = new ProtocolBlob({ source: 'hello', size: 5 })
    expect(blobType().parse(file)).toBe(file)
    expect(() => blobType().parse({})).toThrow(t.NeemataTypeError)
    expect(blobType({ maxSize: 2 }).parse(file)).toBe(file)
  })

  it('retains runtime metadata after nesting without including wire examples', () => {
    const amount = t.custom({
      decode: { type: number(), transform: Number },
      encode: { type: string(), transform: String },
    })
    const schema = t.object({ amount })
    amount.title('Amount').description('Runtime number').examples(42)
    for (const io of ['input', 'output'] as const) {
      const json = schema.parse['~standard'].jsonSchema[io]({
        target: 'draft-07',
      })
      expect(json).toMatchObject({
        properties: {
          amount: {
            type: 'number',
            title: 'Amount',
            description: 'Runtime number',
          },
        },
      })
      expect(json).not.toHaveProperty('properties.amount.examples')
    }
    expect(() =>
      t.date().parse['~standard'].jsonSchema.output({ target: 'draft-07' }),
    ).toThrow()
  })

  it('supports strict Zod compilation of runtime schemas', () => {
    const schema = t.object({
      at: t.date().default(instant),
      ids: t.array(t.bigInt()),
    })
    const compiled = compile(schema.runtimeZodType, { strict: true })
    expect(compiled.parse({ ids: [1n] })).toEqual(schema.parse({ ids: [1n] }))
    expect(() => compiled.parse({ ids: ['1'] })).toThrow(t.NeemataTypeError)
  })
})
