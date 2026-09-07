import { describe, expect, expectTypeOf, it } from 'vitest'
import { number, string, toJSONSchema } from 'zod/mini'

import type { BaseType } from '../src/types/base.ts'
import { t } from '../src/index.ts'
import { typesRegistry } from '../src/types/_metadata.ts'

const options = { target: 'draft-07' } as const
const instant = new Date('2026-09-01T00:00:00.000Z')

// Compare the public projections with Zod's validators to catch structural drift.
describe('wire metadata ownership', () => {
  it.each([
    ['primitive', t.string()],
    ['date', t.date()],
    ['optional', t.date().optional()],
    ['nullable', t.date().nullable()],
    ['default', t.date().default(instant)],
    [
      'object',
      t.object({
        at: t.date(),
        optional: t.string().optional(),
        default: t.date().default(instant),
      }),
    ],
    ['loose object', t.looseObject({ at: t.date() })],
    ['array', t.array(t.date()).min(1).max(3)],
    ['tuple', t.tuple([t.date()], t.date())],
    ['record', t.record(t.string(), t.date())],
    ['union', t.union(t.date(), t.number())],
    [
      'intersection',
      t.intersection(
        t.object({ at: t.date() }),
        t.object({ name: t.string() }),
      ),
    ],
    [
      'discriminated union',
      t.discriminatedUnion(
        'kind',
        t.object({ kind: t.literal('date'), at: t.date() }),
        t.object({ kind: t.literal('text'), text: t.string() }),
      ),
    ],
  ] as const)('preserves native JSON Schema for %s', (_name, schema) => {
    expect(schema.decode['~standard'].jsonSchema.input(options)).toEqual(
      toJSONSchema(schema.decodeZodType, { ...options, io: 'input' }),
    )
    expect(schema.encode['~standard'].jsonSchema.output(options)).toEqual(
      toJSONSchema(schema.encodeZodType, { ...options, io: 'output' }),
    )
  })

  it.each([
    [
      'object',
      t.object({ at: t.date() }),
      { at: instant },
      { at: instant.toISOString() },
    ],
    [
      'loose object',
      t.looseObject({ at: t.date() }),
      { at: instant, name: 'event' },
      { at: instant.toISOString(), name: 'event' },
    ],
    ['array', t.array(t.date()), [instant], [instant.toISOString()]],
    [
      'tuple',
      t.tuple([t.date()], t.date()),
      [instant, instant],
      [instant.toISOString(), instant.toISOString()],
    ],
    [
      'record',
      t.record(t.string(), t.date()),
      { at: instant },
      { at: instant.toISOString() },
    ],
    ['union', t.union(t.date(), t.number()), instant, instant.toISOString()],
    [
      'intersection',
      t.intersection(
        t.object({ at: t.date() }),
        t.object({ name: t.string() }),
      ),
      { at: instant, name: 'event' },
      { at: instant.toISOString(), name: 'event' },
    ],
    [
      'discriminated union',
      t.discriminatedUnion(
        'kind',
        t.object({ kind: t.literal('date'), at: t.date() }),
        t.object({ kind: t.literal('text'), text: t.string() }),
      ),
      { kind: 'date', at: instant },
      { kind: 'date', at: instant.toISOString() },
    ],
    ['optional', t.date().optional(), instant, instant.toISOString()],
    ['nullable', t.date().nullable(), null, null],
    ['default', t.date().default(instant), instant, instant.toISOString()],
  ] as const)(
    'owns examples on the %s value schema',
    (_name, schema, example, encoded) => {
      ;(schema as BaseType).examples(example)
      const nested = t.object({ value: schema })
      for (const projected of [
        nested.decode['~standard'].jsonSchema.input(options),
        nested.encode['~standard'].jsonSchema.output(options),
      ]) {
        expect(projected).toMatchObject({
          properties: { value: { examples: [encoded] } },
        })
      }
    },
  )

  it('updates nested metadata without sharing it with another wrapper or caller schema', () => {
    const wire = string()
    const runtime = number()
    const first = t.custom({
      decode: { type: runtime, transform: Number },
      encode: { type: wire, transform: String },
    })
    const second = t.custom({
      decode: { type: runtime, transform: Number },
      encode: { type: wire, transform: String },
    })
    const optional = first.optional().title('Optional')
    const nested = t.object({ first, second, optional })
    first.title('First').examples(42)
    optional.examples(7)
    for (const projected of [
      nested.decode['~standard'].jsonSchema.input(options),
      nested.encode['~standard'].jsonSchema.output(options),
    ]) {
      expect(projected).toMatchObject({
        properties: {
          first: { title: 'First', examples: ['42'] },
          second: { type: 'string' },
          optional: { title: 'Optional', examples: ['7'] },
        },
      })
      const properties = projected.properties as Record<
        string,
        Record<string, unknown>
      >
      expect(properties.second).not.toHaveProperty('title')
      expect(properties.second).not.toHaveProperty('examples')
    }
    expect(typesRegistry.get(wire)).toBeUndefined()
    expect(typesRegistry.get(runtime)).toBeUndefined()
    first.title('Updated').examples(9)
    expect(nested.decode['~standard'].jsonSchema.input(options)).toMatchObject({
      properties: {
        first: { title: 'Updated', examples: ['9'] },
        optional: { title: 'Optional', examples: ['7'] },
      },
    })
  })

  it('retains examples inherited through wrappers when only their title changes', () => {
    const inner = t.date().examples(instant)
    const wrapped = inner.optional().title('Optional date')
    const nested = t.object({ wrapped })
    for (const projected of [
      nested.decode['~standard'].jsonSchema.input(options),
      nested.encode['~standard'].jsonSchema.output(options),
    ]) {
      expect(projected).toMatchObject({
        properties: {
          wrapped: {
            title: 'Optional date',
            examples: [instant.toISOString()],
          },
        },
      })
    }
  })

  it('preserves named references to reused wire schemas', () => {
    const amount = t
      .custom({
        decode: { type: number(), transform: Number },
        encode: { type: string(), transform: String },
      })
      .meta({ id: 'Amount', examples: [42] })
    const nested = t.object({ first: amount, second: amount })
    for (const projected of [
      nested.decode['~standard'].jsonSchema.input(options),
      nested.encode['~standard'].jsonSchema.output(options),
    ]) {
      expect(projected).toMatchObject({
        properties: {
          first: { $ref: '#/definitions/Amount' },
          second: { $ref: '#/definitions/Amount' },
        },
        definitions: { Amount: { type: 'string', examples: ['42'] } },
      })
    }
  })

  it('encodes examples once through either entry point and preserves other annotations', () => {
    let encodes = 0
    const schema = t.custom({
      decode: { type: number(), transform: Number },
      encode: {
        type: string(),
        transform: (value) => {
          encodes++
          return String(value)
        },
      },
    })
    schema.meta({ title: 'Amount', examples: [42] }).description('An amount')
    expect(encodes).toBe(1)
    expect(schema.decode['~standard'].jsonSchema.input(options)).toMatchObject({
      title: 'Amount',
      description: 'An amount',
      examples: ['42'],
    })
    schema.examples(7)
    expect(encodes).toBe(2)
    expect(schema.encode['~standard'].jsonSchema.output(options)).toMatchObject(
      { title: 'Amount', examples: ['7'] },
    )
    expectTypeOf<Parameters<typeof schema.meta>[0]>().toMatchTypeOf<{
      examples?: number[]
    }>()
    expect(() =>
      schema.meta({ title: 'Invalid', examples: ['bad'] as any }),
    ).toThrow()
    expect(schema.decode['~standard'].jsonSchema.input(options)).toMatchObject({
      title: 'Amount',
      examples: ['7'],
    })
    schema.meta({ examples: undefined })
    expect(
      schema.decode['~standard'].jsonSchema.input(options),
    ).not.toHaveProperty('examples')
  })

  it('keeps examples on wire schemas without changing validation or runtime schemas', () => {
    const schema = t
      .custom({
        decode: { type: number(), transform: Number },
        encode: { type: string(), transform: String },
      })
      .title('Amount')
      .examples(42)
    expect(schema.encode(42)).toBe('42')
    expect(schema.decode('42')).toBe(42)
    for (const projected of [
      schema.encode['~standard'].jsonSchema.input(options),
      schema.decode['~standard'].jsonSchema.output(options),
    ]) {
      expect(projected).toMatchObject({ type: 'number', title: 'Amount' })
      expect(projected).not.toHaveProperty('examples')
    }
    for (const wire of Object.values(schema.wireZodTypes)) {
      expect(
        toJSONSchema(wire, { ...options, metadata: typesRegistry }),
      ).toMatchObject({ type: 'string', examples: ['42'] })
    }
    expect(typesRegistry.get(schema.encodeZodType)).not.toHaveProperty(
      'examples',
    )
    expect(typesRegistry.get(schema.decodeZodType)).not.toHaveProperty(
      'examples',
    )
  })
})
