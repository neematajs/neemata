import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isFactoryInjectable } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createEnvConfig,
  EnvConfigError,
  resolveEnvConfig,
} from '../src/index.ts'

const schema = <Output>(
  validate: (
    value: unknown,
  ) =>
    | StandardSchemaV1.Result<Output>
    | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
  '~standard': { version: 1, vendor: 'test', validate },
})

const intFromString = schema<number>((value) => {
  const parsed = Number(value)
  return Number.isInteger(parsed)
    ? { value: parsed }
    : { issues: [{ message: `expected integer, received ${value}` }] }
})

describe('resolveEnvConfig', () => {
  it('resolves variables using record keys as names', async () => {
    const config = await resolveEnvConfig(
      { HOST: t.string(), PORT: intFromString },
      { HOST: 'localhost', PORT: '3000' },
    )
    expect(config).toEqual({ HOST: 'localhost', PORT: 3000 })
    expectTypeOf(config).toEqualTypeOf<{ HOST: string; PORT: number }>()
  })

  it('resolves renamed variables via the object form', async () => {
    const config = await resolveEnvConfig(
      { dbUrl: { name: 'DATABASE_URL', schema: t.string() } },
      { DATABASE_URL: 'postgres://localhost' },
    )
    expect(config).toEqual({ dbUrl: 'postgres://localhost' })
    expectTypeOf(config).toEqualTypeOf<{ dbUrl: string }>()
  })

  it('supports async standard schemas', async () => {
    const config = await resolveEnvConfig(
      { KEY: schema(async (value) => ({ value: String(value).length })) },
      { KEY: 'abc' },
    )
    expect(config).toEqual({ KEY: 3 })
  })

  it('accepts any standard schema alongside @nmtjs/type', async () => {
    const config = await resolveEnvConfig(
      { NAME: t.string(), COUNT: intFromString },
      { NAME: 'neemata', COUNT: '42' },
    )
    expect(config).toEqual({ NAME: 'neemata', COUNT: 42 })
  })

  it('reads from process.env by default', async () => {
    process.env.NMTJS_CONFIG_TEST = 'value'
    try {
      const config = await resolveEnvConfig({ NMTJS_CONFIG_TEST: t.string() })
      expect(config).toEqual({ NMTJS_CONFIG_TEST: 'value' })
    } finally {
      delete process.env.NMTJS_CONFIG_TEST
    }
  })

  it('aggregates issues across all variables into a single error', async () => {
    const error = await resolveEnvConfig(
      {
        HOST: t.string(),
        PORT: intFromString,
        retries: { name: 'RETRIES', schema: intFromString },
      },
      { HOST: 'localhost', PORT: 'nope' },
    ).then(
      () => null,
      (e) => e,
    )

    expect(error).toBeInstanceOf(EnvConfigError)
    expect(Object.keys(error.issues)).toEqual(['PORT', 'RETRIES'])
    expect(error.message).toContain('PORT: expected integer, received nope')
    expect(error.message).toContain('RETRIES: expected integer')
  })

  it('includes issue paths for structured variables', async () => {
    const error = await resolveEnvConfig(
      {
        NESTED: schema(() => ({
          issues: [{ message: 'invalid', path: ['inner', { key: 'value' }] }],
        })),
      },
      { NESTED: '{}' },
    ).then(
      () => null,
      (e) => e,
    )

    expect(error.message).toContain('NESTED (inner.value): invalid')
  })
})

describe('createEnvConfig', () => {
  it('creates a factory injectable resolving the config', async () => {
    const injectable = createEnvConfig(
      { PORT: intFromString },
      { source: { PORT: '8080' } },
    )
    expect(isFactoryInjectable(injectable)).toBe(true)
    const config = await injectable.create({} as never)
    expect(config).toEqual({ PORT: 8080 })
    expectTypeOf(config).toEqualTypeOf<{ PORT: number }>()
  })
})
