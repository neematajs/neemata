import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec'

/** A provider-independent, one-direction validation or transformation schema. */
export type Schema<Input = unknown, Output = Input> = StandardSchemaV1<
  Input,
  Output
>

export namespace Schema {
  export type Input<Value extends Schema> = StandardSchemaV1.InferInput<Value>

  export type Output<Value extends Schema> = StandardSchemaV1.InferOutput<Value>

  /** A validation schema that can also describe both of its type boundaries. */
  export interface WithJSONSchema<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output> &
      StandardJSONSchemaV1.Props<Input, Output>
  }
}

export namespace WireSchema {
  /** Converts an incoming wire representation into a runtime value. */
  export type Decode<WireInput = unknown, RuntimeOutput = WireInput> = Schema<
    WireInput,
    RuntimeOutput
  >

  /** Converts a runtime value into an outgoing wire representation. */
  export type Encode<
    RuntimeInput = unknown,
    WireOutput = RuntimeInput,
  > = Schema<RuntimeInput, WireOutput>

  /** Explicitly pairs the two independently executable wire directions. */
  export interface Codec<
    DecodeSchema extends Decode = Decode,
    EncodeSchema extends Encode = Encode,
  > {
    readonly decode: DecodeSchema
    readonly encode: EncodeSchema
  }

  export type DecodeSchema<Value extends Decode | Codec> =
    Value extends Codec<infer DecodeValue, any> ? DecodeValue : Value

  export type EncodeSchema<Value extends Encode | Codec> =
    Value extends Codec<any, infer EncodeValue> ? EncodeValue : Value

  export type DecodeInput<Value extends Decode | Codec> = Schema.Input<
    DecodeSchema<Value>
  >

  export type DecodeOutput<Value extends Decode | Codec> = Schema.Output<
    DecodeSchema<Value>
  >

  export type EncodeInput<Value extends Encode | Codec> = Schema.Input<
    EncodeSchema<Value>
  >

  export type EncodeOutput<Value extends Encode | Codec> = Schema.Output<
    EncodeSchema<Value>
  >
}

export type SchemaIssue = StandardSchemaV1.Issue
export type SchemaValidationOptions = StandardSchemaV1.Options

/** Passes values through unchanged; T declares a type without runtime validation. */
export function noopSchema<T = unknown>(): Schema.WithJSONSchema<T> {
  const jsonSchema = ({ target }: StandardJSONSchemaV1.Options) => {
    switch (target) {
      case 'draft-2020-12':
        return { $schema: 'https://json-schema.org/draft/2020-12/schema' }
      case 'draft-07':
        return { $schema: 'http://json-schema.org/draft-07/schema#' }
      case 'draft-04':
        return { $schema: 'http://json-schema.org/draft-04/schema#' }
      case 'openapi-3.0':
        return {}
      default:
        throw new Error(`Unsupported JSON Schema target: ${target}`)
    }
  }

  return Object.freeze({
    '~standard': Object.freeze({
      version: 1,
      vendor: 'neemata',
      validate: (value: unknown) => ({ value: value as T }),
      jsonSchema: Object.freeze({ input: jsonSchema, output: jsonSchema }),
    }),
  })
}

export class SchemaValidationError extends Error {
  override readonly name = 'SchemaValidationError'

  constructor(readonly issues: readonly SchemaIssue[]) {
    super(formatSchemaIssues(issues))
  }
}

export function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path
        ?.map((segment) =>
          typeof segment === 'object' ? String(segment.key) : String(segment),
        )
        .join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('\n')
}

export function isSchema(value: unknown): value is Schema {
  if (!isObjectLike(value) || !('~standard' in value)) return false
  const standard = value['~standard']
  return (
    isObjectLike(standard) &&
    standard.version === 1 &&
    typeof standard.vendor === 'string' &&
    typeof standard.validate === 'function'
  )
}

export function isSchemaWithJSONSchema(
  value: unknown,
): value is Schema.WithJSONSchema {
  if (!isSchema(value)) return false
  const jsonSchema = (
    value['~standard'] as (typeof value)['~standard'] & {
      readonly jsonSchema?: unknown
    }
  ).jsonSchema
  return (
    isObjectLike(jsonSchema) &&
    typeof jsonSchema.input === 'function' &&
    typeof jsonSchema.output === 'function'
  )
}

export function isWireSchemaCodec(value: unknown): value is WireSchema.Codec {
  return isObjectLike(value) && isSchema(value.decode) && isSchema(value.encode)
}

export function getDecodeSchema<
  Value extends WireSchema.Decode | WireSchema.Codec,
>(value: Value): WireSchema.DecodeSchema<Value> {
  return (
    isWireSchemaCodec(value) ? value.decode : value
  ) as WireSchema.DecodeSchema<Value>
}

export function getEncodeSchema<
  Value extends WireSchema.Encode | WireSchema.Codec,
>(value: Value): WireSchema.EncodeSchema<Value> {
  return (
    isWireSchemaCodec(value) ? value.encode : value
  ) as WireSchema.EncodeSchema<Value>
}

/** Executes any Standard Schema and normalizes validation failures. */
export async function validateSchema<Value extends Schema>(
  schema: Value,
  value: unknown,
  options?: SchemaValidationOptions,
): Promise<Schema.Output<Value>> {
  const result = await schema['~standard'].validate(value, options)
  if (result.issues) throw new SchemaValidationError(result.issues)
  return result.value
}

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'
