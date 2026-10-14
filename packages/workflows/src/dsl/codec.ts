import type { EffectSchema } from '@nmtjs/common/effect'
import { assertJson, decodeWith, encodeWith } from '@nmtjs/common'
import { codec } from '@nmtjs/common/effect'
import * as Schema from 'effect/Schema'

/** Schemas must decode synchronously and require no services. */
export type { EffectSchema }

/**
 * One durable boundary: the schema's type on the side of handlers and
 * computed values, its JSON encoding on the side of records. Both directions
 * throw `Invalid <label>`, with the schema's issues as the cause.
 */
export type Boundary<A> = {
  readonly schema: EffectSchema<A>
  readonly encode: (value: A) => unknown
  readonly decode: (stored: unknown) => A
}

export function boundary<A>(
  schema: EffectSchema<A>,
  label: string,
): Boundary<A> {
  // Types rule this out; untyped callers get a build error, not a run failure.
  if (!Schema.isSchema(schema)) throw new Error(`Missing schema for ${label}`)

  const json = codec(schema)
  const guarded = <B>(cross: () => B): B => {
    try {
      return cross()
    } catch (cause) {
      throw new Error(`Invalid ${label}`, { cause })
    }
  }

  return {
    schema,
    encode: (value) =>
      guarded(() => {
        const encoded = encodeWith(json, value)
        // No schema guarantees JSON, and nothing restores what JSON drops.
        assertJson(encoded)
        return encoded
      }),
    decode: (stored) => guarded(() => decodeWith(json, stored) as A),
  }
}
