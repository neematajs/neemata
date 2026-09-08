import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { Schema, WireSchema } from '../src/schema.ts'
import {
  SchemaValidationError,
  getDecodeSchema,
  getEncodeSchema,
  isSchema,
  isSchemaWithJSONSchema,
  isWireSchemaCodec,
  validateSchema,
} from '../src/schema.ts'

const numberFromString: Schema<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      typeof value === 'string' && Number.isFinite(Number(value))
        ? { value: Number(value) }
        : { issues: [{ message: 'Expected a numeric string' }] },
  },
}

const stringFromNumber: Schema<number, string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: async (value) =>
      typeof value === 'number'
        ? { value: String(value) }
        : { issues: [{ message: 'Expected a number' }] },
  },
}

const codec = {
  decode: numberFromString,
  encode: stringFromNumber,
} satisfies WireSchema.Codec

describe('schema capabilities', () => {
  it('executes synchronous and asynchronous Standard Schemas', async () => {
    await expect(validateSchema(numberFromString, '42')).resolves.toBe(42)
    await expect(validateSchema(stringFromNumber, 42)).resolves.toBe('42')
  })

  it('normalizes Standard Schema issues', async () => {
    const error = await validateSchema(numberFromString, 'nope').catch(
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(SchemaValidationError)
    expect(error).toMatchObject({
      issues: [{ message: 'Expected a numeric string' }],
    })
  })

  it('resolves codec directions without treating schemas as codecs', () => {
    expect(isSchema(numberFromString)).toBe(true)
    expect(isWireSchemaCodec(numberFromString)).toBe(false)
    expect(isWireSchemaCodec(codec)).toBe(true)
    expect(getDecodeSchema(codec)).toBe(numberFromString)
    expect(getEncodeSchema(codec)).toBe(stringFromNumber)
    expect(getDecodeSchema(numberFromString)).toBe(numberFromString)
  })

  it('detects JSON Schema independently from validation', () => {
    const described: Schema.WithJSONSchema<string, number> = {
      '~standard': {
        ...numberFromString['~standard'],
        jsonSchema: {
          input: () => ({ type: 'string' }),
          output: () => ({ type: 'number' }),
        },
      },
    }

    expect(isSchemaWithJSONSchema(numberFromString)).toBe(false)
    expect(isSchemaWithJSONSchema(described)).toBe(true)
  })

  it('preserves all four directional types', () => {
    expectTypeOf<WireSchema.DecodeInput<typeof codec>>().toEqualTypeOf<string>()
    expectTypeOf<
      WireSchema.DecodeOutput<typeof codec>
    >().toEqualTypeOf<number>()
    expectTypeOf<WireSchema.EncodeInput<typeof codec>>().toEqualTypeOf<number>()
    expectTypeOf<
      WireSchema.EncodeOutput<typeof codec>
    >().toEqualTypeOf<string>()
    expectTypeOf<
      Schema.Output<typeof numberFromString>
    >().toEqualTypeOf<number>()
    expectTypeOf<
      StandardSchemaV1.InferInput<typeof stringFromNumber>
    >().toEqualTypeOf<number>()
  })
})
