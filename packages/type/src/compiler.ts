import type { TSchema } from '@sinclair/typebox'
import {
  TypeCompiler,
  type ValueErrorIterator,
} from '@sinclair/typebox/compiler'
import {
  TransformDecode,
  TransformEncode,
  Value,
} from '@sinclair/typebox/value'
import { register } from './formats.ts'
import type { t } from './index.ts'
import { IsDiscriminatedUnion } from './schemas/discriminated-union.ts'
import type { BaseType } from './types/base.ts'

type ValidationError = {
  path: string
  message: string
  value: unknown
}

// register ajv formats
register()

export type Compiled<T extends BaseType = BaseType> = {
  check: (val: unknown) => val is t.infer.input.encoded<T>
  errors: (val: unknown) => ValidationError[]
  parse: (val: unknown) => unknown
  /**
   * Requires to `check` before calling
   */
  decode: (val: unknown) => t.infer.decoded<T>
  /**
   * Requires to `check` before calling
   */
  encode: (val: unknown) => t.infer.encoded<T>
  /**
   * Requires to `check` before calling
   */
  decodeSafe: (
    val: unknown,
  ) =>
    | { success: true; value: t.infer.decoded<T> }
    | { success: false; error: any }
  /**
   * Requires to `check` before calling
   */
  encodeSafe: (
    val: unknown,
  ) =>
    | { success: true; value: t.infer.encoded<T> }
    | { success: false; error: any }
}

// FIXME: this one is very slow
function _parse(schema: TSchema, value: any) {
  // Clone -> Clean -> Convert
  return Value.Convert(schema, Value.Clean(schema, Value.Clone(value)))
}

function _errors(errors: ValueErrorIterator) {
  const result: ValidationError[] = []

  for (const error of errors) {
    if (IsDiscriminatedUnion(error.schema)) {
      const discriminator = error.schema.discriminator
      const discriminatorValue = error.value?.[discriminator]
      if (discriminatorValue !== undefined) {
        const variantSchema = error.schema.anyOf.find(
          (schema) =>
            schema.properties[discriminator].const === discriminatorValue,
        )
        if (variantSchema) {
          const propertiesSchemas: TSchema[] = []
          for (const element in variantSchema.properties) {
            const propertySchema = variantSchema.properties[element]
            if (propertySchema !== variantSchema.properties[discriminator]) {
              propertiesSchemas.push(propertySchema)
            }
          }

          for (const iter of error.errors) {
            for (const err of iter) {
              if (!propertiesSchemas.includes(err.schema)) continue
              result.push({
                path: err.path,
                message: err.message,
                value: err.value,
              })
            }
          }

          continue
        }
      }
    }

    result.push({
      path: error.path,
      message: error.message,
      value: error.value,
    })

    for (const nestedError of error.errors) {
      result.push(..._errors(nestedError))
    }
  }

  return result
}

function compileType(type: BaseType) {
  const { schema } = type
  const compiled = TypeCompiler.Compile(schema)
  const errors = (value) => {
    return _errors(compiled.Errors(value))
  }

  return {
    check: compiled.Check.bind(compiled),
    parse: _parse.bind(null, schema),
    errors,
    decode: TransformDecode.bind(null, schema, compiled.References()),
    encode: TransformEncode.bind(null, schema, compiled.References()),
  }
}

export function compile<T extends BaseType>(schema: T): Compiled<T> {
  const compiled = compileType(schema)

  function decodeSafe(val: unknown) {
    try {
      return {
        success: true as const,
        value: compiled.decode(val),
      }
    } catch (error) {
      return { success: false as const, error }
    }
  }

  function encodeSafe(val: unknown) {
    try {
      return {
        success: true as const,
        value: compiled.encode(val),
      }
    } catch (error) {
      return { success: false as const, error }
    }
  }

  return {
    ...compiled,
    decodeSafe,
    encodeSafe,
  } as any
}

export namespace runtime {
  export function parse(type: BaseType, value: unknown) {
    return _parse(type.schema, value)
  }

  export function errors(type: BaseType, value: unknown): ValidationError[] {
    return _errors(Value.Errors(type.schema, value))
  }

  export function check<T extends BaseType>(
    type: T,
    value: unknown,
  ): value is t.infer.input.encoded<T> {
    return Value.Check(type.schema, value)
  }

  export function decode<T extends BaseType>(
    type: T,
    value: unknown,
  ): t.infer.decoded<T> {
    return TransformDecode(type.schema, [], value)
  }

  export function encode<T extends BaseType>(
    type: T,
    value: unknown,
  ): t.infer.encoded<T> {
    return TransformEncode(type.schema, [], value)
  }
}
