import type { WireSchema } from '@nmtjs/common/schema'
import { getDecodeSchema, isSchemaWithJSONSchema } from '@nmtjs/common/schema'

export type ToolInputSchema =
  | { kind: 'object'; schema: Record<string, any> }
  // procedure takes no input — tools/call sends {} and dispatch passes nothing
  | { kind: 'none'; schema: Record<string, any> }

export function emitToolInputSchema(
  type: WireSchema.Decode | WireSchema.Codec | undefined,
): ToolInputSchema {
  if (type === undefined) {
    return {
      kind: 'none',
      schema: { type: 'object', properties: {}, additionalProperties: false },
    }
  }
  const decode = getDecodeSchema(type)
  if (!isSchemaWithJSONSchema(decode)) {
    throw new Error(
      'MCP tool inputs must support Standard JSON Schema emission',
    )
  }
  // MCP describes the incoming wire value, before the decode transformation.
  const schema = decode['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  })
  if (schema.type === 'object') return { kind: 'object', schema }
  throw new Error(
    'MCP tool inputs must be object schemas (or no input at all); ' +
      `got ${JSON.stringify(schema)}`,
  )
}
