import type { TSchema } from '@sinclair/typebox'
import {
  TypeCompiler,
  type ValueErrorIterator,
} from '@sinclair/typebox/compiler'
import { Value } from '@sinclair/typebox/value'
import type { typeStatic } from './constants.ts'
import { type BaseType, getTypeSchema } from './types/base.ts'

export type Compiled<T extends BaseType = BaseType> = {
  check: (val: unknown) => boolean
  errors: (val: unknown) => ValueErrorIterator
  prepare: (val: unknown) => unknown
  convert: (val: unknown) => unknown
  decode: (val: unknown) => T[typeStatic]['decoded']
  encode: (val: unknown) => T[typeStatic]['encoded']
  decodeSafe: (
    val: unknown,
  ) =>
    | { success: true; value: T[typeStatic]['decoded'] }
    | { success: false; error: any }
  encodeSafe: (
    val: unknown,
  ) =>
    | { success: true; value: T[typeStatic]['encoded'] }
    | { success: false; error: any }
}

function _prepare(schema: TSchema, value: any) {
  return Value.Default(schema, Value.Clean(schema, value))
}

function _convert(schema: TSchema, value: any) {
  return Value.Convert(schema, value)
}

function compileType(type: BaseType) {
  const schema = getTypeSchema(type)
  const compiled = TypeCompiler.Compile(schema)
  return {
    check: compiled.Check.bind(compiled),
    errors: compiled.Errors.bind(compiled),
    decode: compiled.Decode.bind(compiled),
    encode: compiled.Encode.bind(compiled),
    prepare: _prepare.bind(null, schema),
    convert: _convert.bind(null, schema),
  }
}

export function compile<T extends BaseType>(schema: T): Compiled<T> {
  const compiled = compileType(schema)

  // TODO: custom error handling/shaping
  return {
    ...compiled,
    decode: (val) => compiled.decode(val),
    encode: (val) => compiled.encode(val),
    decodeSafe: (val) => {
      try {
        return {
          success: true as const,
          value: compiled.decode(val),
        }
      } catch (error) {
        return { success: false as const, error }
      }
    },
    encodeSafe: (val) => {
      try {
        return {
          success: true as const,
          value: compiled.encode(val),
        }
      } catch (error) {
        return { success: false as const, error }
      }
    },
  }
}

export namespace runtime {
  export function prepare(type: BaseType, value: any) {
    return _prepare(getTypeSchema(type), value)
  }

  export function convert(type: BaseType, value: any) {
    return _convert(getTypeSchema(type), value)
  }

  export function errors(type: BaseType, value: any): ValueErrorIterator {
    return Value.Errors(getTypeSchema(type), value)
  }

  export function check(type: BaseType, value: any): boolean {
    return Value.Check(getTypeSchema(type), value)
  }

  export function decode<T extends BaseType>(
    type: BaseType,
    value: any,
  ): T[typeStatic]['decoded'] {
    return Value.Decode(getTypeSchema(type), value)
  }

  export function encode<T extends BaseType>(
    type: T,
    value: any,
  ): T[typeStatic]['encoded'] {
    return Value.Encode(getTypeSchema(type), value)
  }
}
