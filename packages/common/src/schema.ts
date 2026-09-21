import type { StandardSchemaV1 } from '@standard-schema/spec'

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json }

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
