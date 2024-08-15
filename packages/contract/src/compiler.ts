import {
  type TypeCheck,
  TypeCompiler,
  type ValueErrorIterator,
} from '@sinclair/typebox/compiler'
import type { TSchema } from '@sinclair/typebox/type'
import { Value } from '@sinclair/typebox/value'

export type Compiled = {
  check: (val: unknown) => boolean
  errors: (val: unknown) => ValueErrorIterator
  decode: (
    val: unknown,
  ) => { success: true; value: unknown } | { success: false; error: any }
  encode: (
    val: unknown,
  ) => { success: true; value: unknown } | { success: false; error: any }
}

const compileSchema = (
  schema: TSchema,
): TypeCheck<TSchema> & {
  Prepare: (value: any) => unknown
} => {
  const compiled = TypeCompiler.Compile(schema)
  const Prepare = (value: any) => {
    for (const fn of [Value.Clean, Value.Default]) {
      value = fn(schema, value)
    }
    return value
  }
  return Object.assign(compiled, { Prepare })
}

export const compile = (schema: TSchema): Compiled => {
  const compiled = compileSchema(schema)

  // TODO: custom error handling/shaping
  return {
    check: compiled.Check.bind(compiled),
    errors: compiled.Errors.bind(compiled),
    decode: (val) => {
      try {
        return {
          success: true as const,
          value: compiled.Decode(compiled.Prepare(val)),
        }
      } catch (error) {
        return { success: false as const, error }
      }
    },
    encode: (val) => {
      try {
        return {
          success: true as const,
          value: compiled.Encode(compiled.Prepare(val)),
        }
      } catch (error) {
        return { success: false as const, error }
      }
    },
  }
}
