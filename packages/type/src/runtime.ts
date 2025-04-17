import type { TSchema } from '@sinclair/typebox'
import type { ValueErrorIterator } from '@sinclair/typebox/compiler'
import {
  TransformDecode,
  TransformEncode,
  Value,
} from '@sinclair/typebox/value'
import type { ClassConstructor } from '../../common/src/index.ts'
import { register } from './formats.ts'
import type {
  StaticInputEncode,
  StaticOutputDecode,
  StaticOutputEncode,
} from './inference.ts'
import { Clone } from './parse.ts'
import { IsDiscriminatedUnion } from './schemas/discriminated-union.ts'
import type { BaseType } from './types/base.ts'

// register ajv formats
register()

export type CloneOptions = {
  clone?: boolean
  exclude?: Set<any>
}

export type ValidationError = {
  path: string
  message: string
  value: unknown
}

// TODO: this one is very slow
export function _applyDefaults(schema: TSchema, value: any) {
  return Value.Default(schema, value)
}

// TODO: this one is very slow
// Clone -> Clean -> Convert
export function _parse(
  schema: TSchema,
  value: any,
  cloneOptions?: CloneOptions,
) {
  if (cloneOptions?.clone !== false) {
    value = Clone(value, cloneOptions?.exclude)
  }
  return Value.Clean(schema, Value.Convert(schema, value))
}

export function _traversErrors(errors: ValueErrorIterator) {
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
      result.push(..._traversErrors(nestedError))
    }
  }

  return result
}

export function applyDefaults(type: BaseType, value: unknown) {
  return _applyDefaults(type.schema, value)
}

export function parse(
  type: BaseType,
  value: unknown,
  cloneOptions?: CloneOptions,
) {
  return _parse(type.schema, value, cloneOptions)
}

export function errors(type: BaseType, value: unknown): ValidationError[] {
  return _traversErrors(Value.Errors(type.schema, value))
}

export function check<T extends BaseType>(
  type: T,
  value: unknown,
): value is StaticInputEncode<T['schema']> {
  return Value.Check(type.schema, value)
}

export function decode<T extends BaseType>(
  type: T,
  value: unknown,
): StaticOutputDecode<T['schema']> {
  return TransformDecode(type.schema, [], value)
}

export function encode<T extends BaseType>(
  type: T,
  value: unknown,
): StaticOutputEncode<T['schema']> {
  return TransformEncode(type.schema, [], value)
}
