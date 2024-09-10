import { describe, expect, it } from 'vitest'

import { ValueErrorIterator } from '@sinclair/typebox/errors'
import { compile } from '../src/compiler.ts'
import { t } from '../src/index.ts'

describe('Compiler', () => {
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
    expect(errors).toBeInstanceOf(ValueErrorIterator)
    const firstError = errors.First()
    expect(firstError).toBeTruthy()
    expect(firstError).toHaveProperty('type', expect.any(Number))
    expect(firstError).toHaveProperty('schema', expect.any(Object))
    expect(firstError).toHaveProperty('path', expect.any(String))
    expect(firstError).toHaveProperty('value', 'test')
    expect(firstError).toHaveProperty('message', expect.any(String))
  })

  it('should decode successfully', () => {
    const compiled = compile(testSchema)
    const result = compiled.decode({ foo: 'test', bar: 42, extra: 'skipped' })
    expect(result.success).toBe(true)
    expect(result.success && result.value).toEqual({ foo: 'test', bar: 42 })
  })

  it('should fail to decode', () => {
    const compiled = compile(testSchema)
    const result = compiled.decode({
      foo: 'test',
      bar: '42',
      extra: 'skipped',
    })
    expect(result.success).toBe(false)
    expect(!result.success && result.error).toEqual(expect.any(Error))
  })

  it('should encode successfully', () => {
    const compiled = compile(testSchema)
    const result = compiled.encode({ foo: 'test', bar: 42, extra: 'skipped' })
    expect(result.success).toBe(true)
    expect(result.success && result.value).toEqual({ foo: 'test', bar: 42 })
  })

  it('should fail to encode', () => {
    const compiled = compile(testSchema)
    const result = compiled.encode({
      foo: 'test',
      bar: '42',
      extra: 'skipped',
    })
    expect(result.success).toBe(false)
    expect(!result.success && result.error).toEqual(expect.any(Error))
  })
})
