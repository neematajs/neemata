import type { StandardSchemaV1 } from '@standard-schema/spec'
import * as Schema from 'effect/Schema'

import type { PubSubCodec } from '../contract.ts'

/** Schemas must decode synchronously and require no services. */
export type EffectSchema<Type = unknown> = Schema.Codec<Type, unknown>

// Channels are shared with clients that never validate, so Effect derives the
// parser on first use.
function standard<Input, Output>(
  make: () => Schema.Codec<Output, Input>,
): StandardSchemaV1<Input, Output> {
  let made: StandardSchemaV1<Input, Output>['~standard'] | undefined
  return {
    '~standard': {
      version: 1,
      vendor: 'effect',
      validate: (value) =>
        (made ??= Schema.toStandardSchemaV1(make())['~standard']).validate(
          value,
        ),
    },
  }
}

/**
 * Publishes a schema's `Type` through its JSON encoding: `decode` is the
 * schema's JSON codec and `encode` is the same codec flipped.
 */
export function codec<Type>(schema: EffectSchema<Type>): PubSubCodec<Type> {
  let json: Schema.Codec<Type, Schema.Json> | undefined
  const stored = () => (json ??= Schema.toCodecJson(schema))
  return {
    decode: standard(stored),
    encode: standard(() => Schema.flip(stored())),
  }
}
