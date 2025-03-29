import { describe, expect, it } from 'vitest'

import { compile } from '../src/compiler.ts'
import { t } from '../src/index.ts'
import * as runtime from '../src/runtime.ts'

describe('Compiled', () => {
  const testSchema = t.object({
    foo: t.string(),
    bar: t.number(),
  })

  it('should compile a schema', () => {
    const schema = t.object({
      foo: t.string(),
      bar: t.number(),
    })

    const compiled = compile(schema)

    expect(compiled).toHaveProperty('check', expect.any(Function))
    expect(compiled).toHaveProperty('errors', expect.any(Function))
    expect(compiled).toHaveProperty('decode', expect.any(Function))
    expect(compiled).toHaveProperty('encode', expect.any(Function))
  })

  it('should do check correctly', () => {
    const compiled = compile(testSchema)

    expect(compiled.check({ foo: 'test', bar: 42 })).toBe(true)
    expect(compiled.check({ foo: 'test', bar: 'test' })).toBe(false)
  })

  it('should do errors correctly', () => {
    const compiled = compile(testSchema)
    const errors = compiled.errors({ foo: 'test', bar: 'test' })
    expect(errors).toBeInstanceOf(Array)
    const firstError = errors[0]
    expect(firstError).toBeTruthy()
    expect(firstError).toHaveProperty('path', expect.any(String))
    expect(firstError).toHaveProperty('value', 'test')
    expect(firstError).toHaveProperty('message', expect.any(String))
  })

  it('should decodeSafe successfully', () => {
    const compiled = compile(testSchema)
    const result = compiled.decodeSafe({
      foo: 'test',
      bar: 42,
    })
    expect(result.success).toBe(true)
    expect(result.success && result.value).toEqual({ foo: 'test', bar: 42 })
  })

  it('should decode successfully', () => {
    const compiled = compile(testSchema)
    const result = compiled.decode({
      foo: 'test',
      bar: 42,
    })
    expect(result).toEqual({ foo: 'test', bar: 42 })
  })

  it('should encodeSafe successfully', () => {
    const compiled = compile(testSchema)
    const result = compiled.encodeSafe({
      foo: 'test',
      bar: 42,
    })
    expect(result.success).toBe(true)
    expect(result.success && result.value).toEqual({ foo: 'test', bar: 42 })
  })

  it('should encode successfully', () => {
    const compiled = compile(testSchema)
    const result = compiled.encode({
      foo: 'test',
      bar: 42,
    })
    expect(result).toEqual({ foo: 'test', bar: 42 })
  })
})

describe('Runtime', () => {
  const testSchema = t.object({
    foo: t.string(),
    bar: t.number().default(42),
  })

  it('should do check correctly', () => {
    expect(runtime.check(testSchema, { foo: 'test', bar: 42 })).toBe(true)
    expect(runtime.check(testSchema, { foo: 'test', bar: 'test' })).toBe(false)
  })

  it('should do errors correctly', () => {
    const errors = runtime.errors(testSchema, { foo: 'test', bar: 'test' })
    expect(errors).toBeInstanceOf(Array)
    const firstError = errors[0]
    expect(firstError).toBeTruthy()
    expect(firstError).toHaveProperty('path', expect.any(String))
    expect(firstError).toHaveProperty('value', 'test')
    expect(firstError).toHaveProperty('message', expect.any(String))
  })

  it('should parse successfully', () => {
    const result = runtime.parse(testSchema, {
      foo: 'test',
      skipped: true,
      bar: '42',
    })
    expect(result).toEqual({ foo: 'test', bar: 42 })
  })

  it('should decode successfully', () => {
    const result = runtime.decode(testSchema, {
      foo: 'test',
      bar: 42,
    })
    expect(result).toEqual({ foo: 'test', bar: 42 })
  })

  it('should encode successfully', () => {
    const result = runtime.encode(testSchema, {
      foo: 'test',
      bar: 42,
    })
    expect(result).toEqual({ foo: 'test', bar: 42 })
  })
})

describe('Complex schema', () => {
  it('should work', () => {
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
        prop3: t.arrayEnum(['a', 'b', 'c']),
        prop4: t.objectEnum({
          a: 'A',
          b: 'B',
          c: 'C',
        } as const),
      }),
      prop6: t.object.merge(
        t.object({ prop1: t.string() }),
        t.object({ prop2: t.number() }),
      ),
      prop7: t.object.extend(t.object({ prop1: t.string() }), {
        prop2: t.number(),
      }),
      prop8: t.object.omit(t.object({ prop1: t.string(), prop2: t.number() }), {
        prop2: true,
      }),
      prop9: t.object.partial(
        t.object({ prop1: t.string(), prop2: t.number() }),
      ),
      prop10: t.object.pick(
        t.object({ prop1: t.string(), prop2: t.number() }),
        { prop1: true },
      ),
      prop11: t.object.keyof(
        t.object({ prop1: t.string(), prop2: t.number() }),
      ),
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

    const value: any = {
      prop1: 'string',
      prop2: 42,
      prop3: true,
      prop4: [
        {
          prop1: 'a',
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
        prop3: 'a',
        prop4: 'A',
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
      prop11: 'prop1',
      prop12: {
        prop1: 'string',
      },
      prop13: {
        prop1: 'string',
        prop2: 42,
      },
      prop14: {
        type: 'a',
        prop1: 'string',
      },
    }

    const result = runtime.check(schema, value)

    expect(result).toBe(true)
  })
})
