import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'
import * as Schema from 'effect/Schema'

import type { Json, StandardCodec } from './schema.ts'

/** Schemas must decode synchronously and require no services. */
export type EffectSchema<Type = unknown> = Schema.Codec<Type, unknown>

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

const codecs = new WeakMap<EffectSchema, StandardCodec<any, Json>>()
const schemas = new WeakMap<StandardCodec, EffectSchema>()

/**
 * Serializes a schema's `Type` through its JSON encoding: `decode` is the
 * schema's JSON codec and `encode` is the same codec flipped.
 */
export function codec<Type>(
  schema: EffectSchema<Type>,
): StandardCodec<Type, Json> {
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
 * The Effect schema a codec was made from, for composing schemas and for
 * tooling that reads their structure. Undefined for any other schema.
 */
export function schemaOf(
  declared: StandardSchemaV1 | StandardCodec | undefined,
): EffectSchema | undefined {
  return declared && 'decode' in declared ? schemas.get(declared) : undefined
}
