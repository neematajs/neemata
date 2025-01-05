import { describe, expect, it } from 'vitest'

import { compile, runtime } from '../src/compiler.ts'
import { t } from '../src/index.ts'

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
