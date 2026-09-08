import type { BaseTypeAny } from '@nmtjs/type'
import type { core } from 'zod/mini'
import { toJSONSchema } from 'zod/mini'

/**
 * Private, MCP-internal JSON Schema emission. Intentionally NOT a public
 * capability of `@nmtjs/type` — a general emission design is postponed until
 * a second consumer exists (see docs/application-interfaces-plan.md, Slice C).
 * The `encodeZodType` side of a Neemata type describes the wire values an
 * agent actually sends, which is exactly what an MCP `inputSchema` must be.
 */

export type InputSchema =
  | { kind: 'object'; schema: core.JSONSchema.JSONSchema }
  // procedure takes no input — tools/call sends {} and dispatch passes nothing
  | { kind: 'none'; schema: core.JSONSchema.JSONSchema }

export function emitInputSchema(type: BaseTypeAny): InputSchema {
  const schema = toJSONSchema(type.encodeZodType, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  })

  if (schema.type === 'object') return { kind: 'object', schema }

  // zod emits `{ not: {} }` for never — the shape of an input-less procedure
  if (isNeverSchema(schema)) {
    return {
      kind: 'none',
      schema: { type: 'object', properties: {}, additionalProperties: false },
    }
  }

  throw new Error(
    'MCP tool inputs must be object schemas (or no input at all); ' +
      `got ${JSON.stringify(schema)}`,
  )
}

function isNeverSchema(schema: core.JSONSchema.JSONSchema): boolean {
  return (
    'not' in schema &&
    typeof schema.not === 'object' &&
    schema.not !== null &&
    Object.keys(schema.not).length === 0
  )
}
