import type { EffectSchema as AnyEffectSchema } from '@nmtjs/common/effect'
import type * as Schema from 'effect/Schema'

import type { SchemaKind } from '../types/index.ts'

export { codec, schemaOf } from '@nmtjs/common/effect'

/** Schemas must decode synchronously and require no services at durable boundaries. */
export type EffectSchema = AnyEffectSchema

export interface EffectSchemaKind extends SchemaKind {
  readonly bound: EffectSchema
  readonly type: this['schema'] extends Schema.Codec<infer Type, unknown>
    ? Type
    : never
  // Every Effect schema becomes a { decode, encode } pair.
  readonly check: unknown
}
