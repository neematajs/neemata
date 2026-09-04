import type { WireSchema } from '@nmtjs/common/schema'
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { t } from '../src/index.ts'

describe('Standard schema', () => {
  const schema = t.object({
    id: t.bigInt(),
    createdAt: t.date(),
    name: t.string(),
  })

  it('supports decode validation', async () => {
    const standard = schema.decode['~standard']
    const result = await standard.validate({
      id: '123',
      createdAt: '2021-01-01T00:00:00.000Z',
      name: 'Ada',
    })

    if ('value' in result === false)
      throw new Error('Expected decode validation to succeed')

    expect(result.value.id).toBe(123n)
    expect(result.value.createdAt).toBeInstanceOf(Date)

    const invalid = await standard.validate({
      id: 'nope',
      createdAt: 'bad',
      name: 123,
    })

    expect('issues' in invalid).toBe(true)

    if ('issues' in invalid && invalid.issues) {
      expect(invalid.issues.length).toBeGreaterThan(0)
    }
  })

  it('supports encode validation', async () => {
    const standard = schema.encode['~standard']
    const result = await standard.validate({
      id: 123n,
      createdAt: new Date('2021-01-01T00:00:00.000Z'),
      name: 'Ada',
    })

    if ('value' in result === false) {
      throw new Error('Expected encode validation to succeed')
    }

    expect(result.value.id).toBe('123')
    expect(result.value.createdAt).toBe('2021-01-01T00:00:00.000Z')

    const invalid = await standard.validate({
      id: 123,
      createdAt: '2021-01-01',
      name: 'Ada',
    } as any)

    expect('issues' in invalid).toBe(true)
  })

  it('awaits asynchronous provider validation through Standard Schema', async () => {
    const asyncSchema = t.custom<string>({
      decode: (value) => String(value),
      encode: (value) => value,
      validation: {
        decode: async (value, context) => {
          await Promise.resolve()
          if (value !== 'valid') context.addIssue('expected valid')
        },
      },
    }).decode

    await expect(asyncSchema['~standard'].validate('valid')).resolves.toEqual({
      value: 'valid',
    })
    await expect(asyncSchema['~standard'].validate('invalid')).resolves.toEqual(
      {
        issues: [{ message: 'expected valid' }],
      },
    )
  })

  it('exposes JSON schema helpers', () => {
    const standard = schema.decode['~standard']

    const inputSchema = standard.jsonSchema.input({ target: 'draft-07' })

    expect(typeof inputSchema).toBe('object')
    expect(inputSchema).toHaveProperty('type')
    expect(() => standard.jsonSchema.output({ target: 'draft-07' })).toThrow(
      'BigInt cannot be represented in JSON Schema',
    )
  })

  it('infers JSON schema for custom types', () => {
    const bigIntStandard = t.bigInt().decode['~standard']
    const bigIntSchema = bigIntStandard.jsonSchema.input({ target: 'draft-07' })

    expect(bigIntSchema).toHaveProperty('type', 'string')
    expect(bigIntSchema).toHaveProperty('pattern')

    const dateStandard = t.date().decode['~standard']
    const dateSchema = dateStandard.jsonSchema.input({ target: 'draft-07' })

    expect(dateSchema).toHaveProperty('anyOf')
    if ('anyOf' in dateSchema && Array.isArray(dateSchema.anyOf)) {
      for (const entry of dateSchema.anyOf) {
        expect(entry).toHaveProperty('type', 'string')
      }
    }
  })

  it('does not choose a default Standard Schema direction', () => {
    const baseSchema = t.string()

    expect('~standard' in baseSchema).toBe(false)
    expect(baseSchema.decode).not.toBe(baseSchema.encode)
  })

  it('has correct typings', async () => {
    const standard = schema.decode

    expectTypeOf(standard['~standard'].vendor).toEqualTypeOf<string>()
    expectTypeOf(standard['~standard'].version).toEqualTypeOf<1>()

    const result = await standard['~standard'].validate({
      id: '123',
      createdAt: '2021-01-01T00:00:00.000Z',
      name: 'Ada',
    })

    if ('value' in result === false) {
      throw new Error('Expected typing validation to succeed')
    }

    expectTypeOf(result.value).toEqualTypeOf<{
      id: bigint
      createdAt: Date
      name: string
    }>()

    const invalid = await standard['~standard'].validate({
      id: 'nope',
      createdAt: 'bad',
      name: 123,
    })

    if ('issues' in invalid === false) {
      throw new Error('Expected typing validation to fail')
    }

    expectTypeOf(invalid.issues!).toEqualTypeOf<
      ReadonlyArray<StandardSchemaV1.Issue>
    >()
  })

  it('marks codec directions as StandardSchemaV1', () => {
    type IsStandard<T> = T extends StandardSchemaV1<any, any> ? true : false

    expectTypeOf<
      IsStandard<ReturnType<typeof t.string>['decode']>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandard<ReturnType<typeof t.date>['encode']>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandard<ReturnType<typeof t.bigInt>>
    >().toEqualTypeOf<false>()
  })

  it('marks codec directions as StandardJSONSchemaV1', () => {
    type IsStandardJSON<T> =
      T extends StandardJSONSchemaV1<any, any> ? true : false

    expectTypeOf<
      IsStandardJSON<ReturnType<typeof t.string>['decode']>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandardJSON<ReturnType<typeof t.date>['encode']>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandardJSON<ReturnType<typeof t.bigInt>>
    >().toEqualTypeOf<false>()
  })

  it('marks base types as wire schema codecs', () => {
    type IsCodec<T> = T extends WireSchema.Codec ? true : false

    expectTypeOf<IsCodec<ReturnType<typeof t.string>>>().toEqualTypeOf<true>()
    expectTypeOf<IsCodec<ReturnType<typeof t.date>>>().toEqualTypeOf<true>()
  })

  it('preserves output inference through StandardSchemaV1 generics', () => {
    function acceptStandardSchema<Schema extends StandardSchemaV1>(
      schema: Schema,
    ) {
      return schema
    }

    const schema = acceptStandardSchema(
      t.object({
        id: t.bigInt(),
        createdAt: t.date(),
        name: t.string(),
      }).decode,
    )

    expectTypeOf<StandardSchemaV1.InferOutput<typeof schema>>().toEqualTypeOf<{
      id: bigint
      createdAt: Date
      name: string
    }>()
  })
})
