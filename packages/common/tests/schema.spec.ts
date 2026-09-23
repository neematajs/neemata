import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { codec, schemaOf } from '../src/effect.ts'
import {
  assertJson,
  decodeWith,
  encodeWith,
  SchemaError,
} from '../src/schema.ts'

const text: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      typeof value === 'string'
        ? { value }
        : {
            issues: [{ message: 'Expected a string', path: ['a', { key: 0 }] }],
          },
  },
}

describe('schema helpers', () => {
  it('validates a single schema in both directions and reports issue paths', () => {
    expect(encodeWith(text, 'x')).toBe('x')
    expect(decodeWith(text, 'x')).toBe('x')
    expect(() => decodeWith(text, 1)).toThrow(SchemaError)
    expect(() => decodeWith(text, 1)).toThrow('a.0: Expected a string')
  })

  it('rejects asynchronous validation', () => {
    const later: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => ({ value }),
      },
    }
    expect(() => decodeWith(later, 1)).toThrow(
      'Schemas must validate synchronously',
    )
  })

  it('accepts only values that survive a JSON round trip', () => {
    expect(() =>
      assertJson({
        text: 'x',
        count: 1,
        flag: false,
        none: null,
        omitted: undefined,
        list: [1, [2], { three: 3 }],
        bare: Object.assign(Object.create(null), { key: 'value' }),
      }),
    ).not.toThrow()

    // oxlint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3]
    const rejected: [unknown, string][] = [
      [undefined, '$'],
      [{ at: new Date() }, '$.at'],
      [{ n: Number.NaN }, '$.n'],
      [[Infinity], '$[0]'],
      [1n, '$'],
      [sparse, '$[1]'],
      [[1, undefined], '$[1]'],
      [new Map(), '$'],
      [{ nested: [{ fn: () => 1 }] }, '$.nested[0].fn'],
    ]
    for (const [value, path] of rejected)
      expect(() => assertJson(value)).toThrow(
        new TypeError(`Expected a JSON value at ${path}`),
      )
  })

  it('turns an Effect schema into a JSON codec pair it can be recovered from', () => {
    const date = codec(Schema.DateTimeUtcFromString)
    const stored = '2026-01-01T00:00:00.000Z'
    const value = decodeWith(date, stored)
    expect(encodeWith(date, value)).toBe(stored)
    expect(() => decodeWith(date, 'never')).toThrow(SchemaError)

    expect(codec(Schema.DateTimeUtcFromString)).toBe(date)
    expect(schemaOf(date)).toBe(Schema.DateTimeUtcFromString)
    expect(schemaOf(text)).toBeUndefined()
    // The pair's type is the portable one; Effect's also carries JSON Schema.
    const described = date.decode as unknown as StandardJSONSchemaV1
    expect(
      described['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    ).toMatchObject({ type: 'string' })
  })
})
