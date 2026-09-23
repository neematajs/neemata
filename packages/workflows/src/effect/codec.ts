import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import * as Schema from 'effect/Schema'

import type {
  Json,
  Schema as WorkflowSchema,
  SchemaKind,
  WorkflowCodec,
} from '../types/index.ts'

/** Schemas must decode synchronously and require no services at durable boundaries. */
export type EffectSchema = Schema.Codec<unknown, unknown>

export interface EffectSchemaKind extends SchemaKind {
  readonly bound: EffectSchema
  readonly type: this['schema'] extends Schema.Codec<infer Type, unknown>
    ? Type
    : never
  // Every Effect schema becomes a { decode, encode } pair.
  readonly check: unknown
}

type Standard<Input, Output> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>

// Definitions are shared with clients that never validate, so Effect derives
// the parser and JSON Schema on first use.
function standard<Input, Output>(
  make: () => Schema.Codec<Output, Input>,
): Standard<Input, Output> {
  let made: Standard<Input, Output>['~standard'] | undefined
  const props = () =>
    (made ??= Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(make()))[
      '~standard'
    ])
  return {
    '~standard': {
      version: 1,
      vendor: 'effect',
      validate: (value) => props().validate(value),
      jsonSchema: {
        input: (options) => props().jsonSchema.input(options),
        output: (options) => props().jsonSchema.output(options),
      },
    },
  }
}

const codecs = new WeakMap<EffectSchema, WorkflowCodec<any, Json>>()
const schemas = new WeakMap<WorkflowCodec, EffectSchema>()

/**
 * Stores a schema's `Type` through its JSON encoding: `decode` is the schema's
 * JSON codec and `encode` is the same codec flipped.
 */
export function codec<Type>(
  schema: Schema.Codec<Type, unknown>,
): WorkflowCodec<Type, Json> {
  let result = codecs.get(schema)
  if (!result) {
    let json: Schema.Codec<Type, Schema.Json> | undefined
    const stored = () => (json ??= Schema.toCodecJson(schema))
    result = {
      decode: standard(stored),
      encode: standard(() => Schema.flip(stored())),
    }
    codecs.set(schema, result)
    schemas.set(result, schema)
  }
  return result
}

/**
 * The schema a definition's `input`, `output` or `item` was declared with, for
 * composing schemas and for tooling that reads their structure. Undefined for a
 * codec that did not come from this adapter.
 */
export function schemaOf(
  declared: WorkflowSchema | undefined,
): EffectSchema | undefined {
  return declared && 'decode' in declared ? schemas.get(declared) : undefined
}
