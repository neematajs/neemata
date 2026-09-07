import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { emitToolInputSchema } from '../../src/mcp/schema.ts'

describe('MCP input schemas', () => {
  it('describes the incoming wire shape of codecs and directional schemas', () => {
    const codec = t.object({ at: t.date() })
    for (const schema of [codec, codec.decode]) {
      expect(emitToolInputSchema(schema)).toMatchObject({
        kind: 'object',
        schema: {
          properties: {
            at: {
              anyOf: [
                { type: 'string', format: 'date' },
                { type: 'string', format: 'date-time' },
              ],
            },
          },
        },
      })
    }
    expect(emitToolInputSchema(z.object({ count: z.number() }))).toMatchObject({
      kind: 'object',
      schema: { properties: { count: { type: 'number' } } },
    })
  })

  it('distinguishes missing input from an explicitly impossible input', () => {
    expect(emitToolInputSchema(undefined)).toEqual({
      kind: 'none',
      schema: { type: 'object', properties: {}, additionalProperties: false },
    })
    expect(() => emitToolInputSchema(t.never())).toThrow(
      'must be object schemas',
    )
    expect(() => emitToolInputSchema(t.any())).toThrow('must be object schemas')
  })

  it('reports providers without JSON Schema emission as configuration errors', () => {
    expect(() =>
      emitToolInputSchema({
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) => ({ value }),
        },
      }),
    ).toThrow('must support Standard JSON Schema emission')
  })
})
