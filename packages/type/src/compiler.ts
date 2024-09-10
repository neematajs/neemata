import {
  TypeCompiler,
  type ValueErrorIterator,
} from '@sinclair/typebox/compiler'
import { Value } from '@sinclair/typebox/value'
import { type BaseType, getTypeSchema } from './types/base.ts'

export type Compiled = {
  check: (val: unknown) => boolean
  errors: (val: unknown) => ValueErrorIterator
  prepare: (val: unknown) => unknown
  convert: (val: unknown) => unknown
  decode: (
    val: unknown,
  ) => { success: true; value: unknown } | { success: false; error: any }
  encode: (
    val: unknown,
  ) => { success: true; value: unknown } | { success: false; error: any }
}

const compileType = (type: BaseType) => {
  const schema = getTypeSchema(type)
  const compiled = TypeCompiler.Compile(schema)
  const prepare = (value: any) => {
    for (const fn of [Value.Clean, Value.Default]) {
      value = fn(schema, value)
    }
    return value
  }
  const convert = (value: any) => Value.Convert(schema, value)
  return {
    check: compiled.Check.bind(compiled),
    errors: compiled.Errors.bind(compiled),
    decode: compiled.Decode.bind(compiled),
    encode: compiled.Encode.bind(compiled),
    prepare,
    convert,
  }
}

export const compile = (schema: BaseType): Compiled => {
  const compiled = compileType(schema)

  // TODO: custom error handling/shaping
  return {
    ...compiled,
    decode: (val) => {
      try {
        return {
          success: true as const,
          value: compiled.decode(compiled.prepare(val)),
        }
      } catch (error) {
        return { success: false as const, error }
      }
    },
    encode: (val) => {
      try {
        return {
          success: true as const,
          value: compiled.encode(compiled.prepare(val)),
        }
      } catch (error) {
        return { success: false as const, error }
      }
    },
  }
}
