import type { CodecSchema } from '@nmtjs/common'
import type { EffectSchema as AnyEffectSchema } from '@nmtjs/common/effect'
import { codec } from '@nmtjs/common/effect'
import * as Schema from 'effect/Schema'

import type {
  CodecKind,
  SchemaCheck,
  SchemaKind,
  SchemaType,
} from '../types/index.ts'

export { codec, schemaOf } from '@nmtjs/common/effect'

/** Schemas must decode synchronously and require no services at durable boundaries. */
export type EffectSchema = AnyEffectSchema

// Distributes, so a union of Effect and Standard schemas types as the union of
// their values.
type EffectOrCodecType<S> =
  S extends Schema.Codec<infer Type, unknown> ? Type : SchemaType<CodecKind, S>

/**
 * Effect schemas, or anything core definitions take, so an Effect application
 * can reuse the Standard schemas it already has.
 */
export interface EffectSchemaKind extends SchemaKind {
  readonly bound: EffectSchema | CodecSchema
  readonly type: EffectOrCodecType<this['schema']>
  // Every Effect schema becomes a { decode, encode } pair, so only Standard
  // schemas can be a lone transform, and the core check passes the rest. The
  // check stays unresolved for a type parameter, so the EffectSchema member
  // admits one constrained to Effect schemas, as generic wrappers need.
  readonly check: EffectSchema | SchemaCheck<CodecKind, this['schema']>
}

/** Converts Effect schemas; Standard schemas and codecs are stored as given. */
export function toCodec(schema: EffectSchema | CodecSchema): CodecSchema {
  return Schema.isSchema(schema) ? codec(schema) : schema
}
