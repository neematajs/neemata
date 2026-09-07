import { describe, expect, it } from 'vitest'
import { compile, core, number, string } from 'zod/mini'

import { t } from '../src/index.ts'

describe('compiled schema parity', () => {
  const amount = t.custom({
    decode: { type: number(), transform: Number },
    encode: { type: string(), transform: String },
    validation: {
      runtime(value, ctx) {
        if (!Number.isInteger(value)) ctx.addIssue('Integer required')
      },
      decode(value, ctx) {
        if (value < 0) ctx.addIssue('Incoming must be nonnegative')
      },
      encode(value, ctx) {
        if (value > 10) ctx.addIssue('Outgoing maximum is ten')
      },
    },
  })

  it('preserves grouped custom transforms and shared/directional checks', () => {
    const decode = compile(amount.decodeZodType, { strict: true })
    const encode = compile(amount.encodeZodType, { strict: true })
    const parse = compile(amount.runtimeZodType, { strict: true })
    expect(decode).not.toBe(amount.decodeZodType)
    expect(encode).not.toBe(amount.encodeZodType)
    expect(parse).not.toBe(amount.runtimeZodType)
    expect(decode.parse('11')).toBe(11)
    expect(encode.parse(-1)).toBe('-1')
    expect(parse.parse(-1)).toBe(-1)
    expect(parse.parse(11)).toBe(11)
    for (const [compiled, schema, value] of [
      [decode, amount.decodeZodType, '-1'],
      [decode, amount.decodeZodType, '1.5'],
      [decode, amount.decodeZodType, 'invalid'],
      [encode, amount.encodeZodType, 11],
      [encode, amount.encodeZodType, 1.5],
      [parse, amount.runtimeZodType, '1'],
      [parse, amount.runtimeZodType, 1.5],
    ] as const) {
      const result = compiled.safeParse(value)
      const expected = schema.safeParse(value)
      expect(result.success).toBe(false)
      expect(expected.success).toBe(false)
      if (!result.success && !expected.success) {
        expect(result.error.issues).toEqual(expected.error.issues)
      }
    }
  })

  it('preserves defaults, optional values, and nested error paths in every direction', () => {
    const date = new Date('2026-09-08T00:00:00.000Z')
    const schema = t.object({
      at: t.date().default(date),
      items: t.array(t.object({ amount: amount.default(2) })),
      id: t.bigInt().optional(),
    })
    for (const [type, valid, invalid] of [
      [
        schema.decodeZodType,
        { items: [{}] },
        { items: [{ amount: 'invalid' }] },
      ],
      [
        schema.encodeZodType,
        { items: [{}] },
        { items: [{ amount: 'invalid' }] },
      ],
      [
        schema.runtimeZodType,
        { items: [{}] },
        { items: [{ amount: 'invalid' }] },
      ],
    ] as const) {
      const compiled = compile(type, { strict: true })
      expect(compiled).not.toBe(type)
      expect(compiled.parse(valid)).toEqual(type.parse(valid))
      const result = compiled.safeParse(invalid)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(['items', 0, 'amount'])
      }
    }
  })

  it('preserves any and undefined values when compiled', () => {
    const schema = t.object({ value: t.any(), optional: t.string().optional() })
    for (const type of [
      schema.decodeZodType,
      schema.encodeZodType,
      schema.runtimeZodType,
    ]) {
      const compiled = compile(type, { strict: true })
      for (const value of [undefined, null, false, 0, '', { ok: true }]) {
        expect(compiled.parse({ value })).toEqual(type.parse({ value }))
      }
    }
  })

  it('preserves async validation and rejects synchronous parsing of async checks', async () => {
    const schema = t.custom({
      decode: { type: number(), transform: Number },
      encode: { type: string(), transform: String },
      async validation(value, ctx) {
        await Promise.resolve()
        if (value < 0) ctx.addIssue('Must be nonnegative')
      },
    })
    for (const [type, valid, invalid] of [
      [schema.decodeZodType, '2', '-1'],
      [schema.encodeZodType, 2, -1],
      [schema.runtimeZodType, 2, -1],
    ] as const) {
      const compiled = compile(type, { strict: true })
      expect(compiled).not.toBe(type)
      expect(() => compiled.parse(valid)).toThrow(core.$ZodAsyncError)
      await expect(compiled.parseAsync(valid)).resolves.toEqual(
        await type.parseAsync(valid),
      )
      await expect(compiled.parseAsync(invalid)).rejects.toThrow(
        'Must be nonnegative',
      )
    }
  })
})
