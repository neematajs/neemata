import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json }

/**
 * Asserts a value survives a JSON round trip unchanged. No schema library
 * guarantees JSON, and nothing can restore what JSON drops or rewrites.
 * Undefined object properties are the exception: JSON omits them, as readers
 * expect.
 */
export function assertJson(value: unknown, path = '$'): asserts value is Json {
  if (value === null) return
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return
  if (Array.isArray(value)) {
    // Indexed, not forEach: holes would be skipped, and JSON writes them as null.
    for (let index = 0; index < value.length; index++)
      assertJson(value[index], `${path}[${index}]`)
    return
  }
  const prototype =
    typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  if (prototype === Object.prototype || prototype === null) {
    for (const [key, member] of Object.entries(value as object))
      if (member !== undefined) assertJson(member, `${path}.${key}`)
    return
  }
  throw new TypeError(`Expected a JSON value at ${path}`)
}

/**
 * A transformed value's serialized boundary, as two Standard Schemas: `decode`
 * validates the serialized form into `Type`, `encode` validates `Type` into the
 * form to serialize. Standard Schema validates in one direction only, hence the
 * pair.
 */
export type StandardCodec<Type = any, Encoded = any> = {
  readonly decode: StandardSchemaV1<unknown, Type>
  readonly encode: StandardSchemaV1<Type, Encoded>
}

/**
 * A single Standard Schema serves values that are serialized as they are: it
 * validates them on the way in and on the way out.
 */
export type CodecSchema = StandardSchemaV1<any, any> | StandardCodec

export type CodecSchemaOutput<T extends CodecSchema> =
  T extends StandardSchemaV1<any, infer Type>
    ? Type
    : T extends StandardCodec<infer Type>
      ? Type
      : never

declare const notReversible: unique symbol
export type NotReversible<Input, Output> = {
  readonly [notReversible]: 'This schema transforms its input, so its output cannot be serialized and validated again; pass { decode, encode } schemas instead'
  readonly input: Input
  readonly output: Output
}

/** Intersect with a schema option to reject a lone transforming schema. */
export type CodecSchemaCheck<T> =
  T extends StandardSchemaV1<infer Input, infer Output>
    ? [Output] extends [Input]
      ? unknown
      : NotReversible<Input, Output>
    : unknown

/** The issues a schema reported for a value crossing a serialized boundary. */
export class SchemaError extends Error {
  constructor(readonly issues: readonly StandardSchemaV1.Issue[]) {
    super(
      issues
        .map((issue) => {
          const path = (issue.path ?? [])
            .map((segment) =>
              typeof segment === 'object' ? segment.key : segment,
            )
            .join('.')
          return path ? `${path}: ${issue.message}` : issue.message
        })
        .join('; '),
    )
    this.name = 'SchemaError'
  }
}

// Callers validate inside synchronous sections: engine commits, stream pumps.
export function validateSync(
  schema: StandardSchemaV1,
  value: unknown,
): unknown {
  const result = schema['~standard'].validate(value)
  if (result instanceof Promise)
    throw new TypeError('Schemas must validate synchronously')
  if (result.issues) throw new SchemaError(result.issues)
  return result.value
}

export function encodeWith(schema: CodecSchema, value: unknown): unknown {
  return validateSync('~standard' in schema ? schema : schema.encode, value)
}

export function decodeWith(schema: CodecSchema, value: unknown): unknown {
  return validateSync('~standard' in schema ? schema : schema.decode, value)
}
