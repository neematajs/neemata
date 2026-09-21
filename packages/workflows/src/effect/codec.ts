import * as Schema from 'effect/Schema'

import type { Json, SchemaKind, WorkflowCodec } from '../types/index.ts'

/** Schemas must decode synchronously and require no services at durable boundaries. */
export type EffectSchema = Schema.Codec<unknown, unknown>

export interface EffectSchemaKind extends SchemaKind {
  readonly bound: EffectSchema
  readonly type: this['schema'] extends Schema.Codec<infer Type, unknown>
    ? Type
    : never
}

const codecs = new WeakMap<EffectSchema, WorkflowCodec<any>>()

/**
 * Stores a schema's `Type` through its JSON encoding. Definitions are shared
 * with clients that never decode, so both parsers compile on first use; re-entry
 * then decodes every completed node with the compiled one.
 */
export function codec<Type>(
  schema: Schema.Codec<Type, unknown>,
): WorkflowCodec<Type> {
  let result = codecs.get(schema)
  if (!result) {
    let json: Schema.Codec<Type, Schema.Json> | undefined
    let decode: ((stored: unknown) => Type) | undefined
    let encode: ((value: unknown) => Schema.Json) | undefined
    const stored = () => (json ??= Schema.toCodecJson(schema))
    result = {
      decode: (value) => (decode ??= Schema.decodeUnknownSync(stored()))(value),
      encode: (value) =>
        (encode ??= Schema.encodeUnknownSync(stored()))(value) as Json,
    }
    codecs.set(schema, result)
  }
  return result
}
