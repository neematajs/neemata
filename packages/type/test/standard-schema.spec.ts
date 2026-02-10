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
    const standard = schema.standard.decode['~standard']
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
    const standard = schema.standard.encode['~standard']
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
  })

  it('exposes JSON schema helpers', () => {
    const standard = schema.standard.decode['~standard']

    const inputSchema = standard.jsonSchema.input({ target: 'draft-07' })
    const outputSchema = standard.jsonSchema.output({ target: 'draft-07' })

    expect(typeof inputSchema).toBe('object')
    expect(typeof outputSchema).toBe('object')
    expect(inputSchema).toHaveProperty('type')
    expect(outputSchema).toHaveProperty('type')
  })

  it('infers JSON schema for custom types', () => {
    const bigIntStandard = t.bigInt().standard.decode['~standard']
    const bigIntSchema = bigIntStandard.jsonSchema.input({ target: 'draft-07' })

    expect(bigIntSchema).toHaveProperty('type', 'string')
    expect(bigIntSchema).toHaveProperty('pattern')

    const dateStandard = t.date().standard.decode['~standard']
    const dateSchema = dateStandard.jsonSchema.input({ target: 'draft-07' })

    expect(dateSchema).toHaveProperty('anyOf')
    if ('anyOf' in dateSchema && Array.isArray(dateSchema.anyOf)) {
      for (const entry of dateSchema.anyOf) {
        expect(entry).toHaveProperty('type', 'string')
      }
    }
  })

  it('exposes base standard schema alias', async () => {
    const baseSchema = t.string()

    expect(baseSchema['~standard']).toBe(
      baseSchema.standard.decode['~standard'],
    )

    const result = await baseSchema['~standard'].validate('ok')

    if ('value' in result === false) {
      throw new Error('Expected base standard validation to succeed')
    }

    expect(result.value).toBe('ok')
  })

  it('has correct typings', async () => {
    const standard = schema.standard.decode

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

  it('marks base types as StandardSchemaV1', () => {
    type IsStandard<T> = T extends StandardSchemaV1<any, any> ? true : false

    expectTypeOf<
      IsStandard<ReturnType<typeof t.string>>
    >().toEqualTypeOf<true>()
    expectTypeOf<IsStandard<ReturnType<typeof t.date>>>().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandard<ReturnType<typeof t.bigInt>>
    >().toEqualTypeOf<true>()
  })

  it('marks base types as StandardJSONSchemaV1', () => {
    type IsStandardJSON<T> =
      T extends StandardJSONSchemaV1<any, any> ? true : false

    expectTypeOf<
      IsStandardJSON<ReturnType<typeof t.string>>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandardJSON<ReturnType<typeof t.date>>
    >().toEqualTypeOf<true>()
    expectTypeOf<
      IsStandardJSON<ReturnType<typeof t.bigInt>>
    >().toEqualTypeOf<true>()
  })
})
