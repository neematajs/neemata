import type { BaseTypeAny } from '@nmtjs/type'
import { toJSONSchema } from 'zod/mini'

/**
 * Private, MCP-internal JSON Schema emission. Intentionally NOT a public
 * capability of `@nmtjs/type` — a general emission design is postponed until
 * a second consumer exists (see docs/application-interfaces-plan.md, Slice C).
 * The `encodeZodType` side of a Neemata type describes the wire values an
 * agent actually sends, which is exactly what an MCP `inputSchema` must be.
 */

export type ToolInputSchema =
  | { kind: 'object'; schema: Record<string, any> }
  // procedure takes no input — tools/call sends {} and dispatch passes nothing
  | { kind: 'none'; schema: Record<string, any> }

export function emitToolInputSchema(type: BaseTypeAny): ToolInputSchema {
  const schema = toJSONSchema(type.encodeZodType, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, any>

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

function isNeverSchema(schema: Record<string, any>): boolean {
  return (
    'not' in schema &&
    typeof schema.not === 'object' &&
    schema.not !== null &&
    Object.keys(schema.not).length === 0
  )
}
