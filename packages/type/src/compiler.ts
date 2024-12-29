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
  parse: (val: unknown) => unknown
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

function _parse(schema: TSchema, value: any) {
  // Clone -> Clean -> Default -> Convert
  return Value.Convert(
    schema,
    Value.Default(schema, Value.Clean(schema, Value.Clone(value))),
  )
}

function compileType(type: BaseType) {
  const schema = getTypeSchema(type)
  const compiled = TypeCompiler.Compile(schema)
  return {
    check: compiled.Check.bind(compiled),
    errors: compiled.Errors.bind(compiled),
    decode: compiled.Decode.bind(compiled),
    encode: compiled.Encode.bind(compiled),
    parse: _parse.bind(null, schema),
  }
}

export function compile<T extends BaseType>(schema: T): Compiled<T> {
  const compiled = compileType(schema)

  return {
    ...compiled,
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
  export function parse(type: BaseType, value: any) {
    return _parse(getTypeSchema(type), value)
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
