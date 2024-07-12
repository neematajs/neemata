import { TypeCompiler } from '@sinclair/typebox/compiler'
import type { TSchema } from '@sinclair/typebox/type'

export type Compiled = {
  check: (val: unknown) => boolean
  decode: (
    val: unknown,
  ) => { success: true; value: unknown } | { success: false; error: any }
  encode: (
    val: unknown,
  ) => { success: true; value: unknown } | { success: false; error: any }
}

export const compile = (schema: TSchema): Compiled => {
  const compiled = TypeCompiler.Compile(schema)

  // TODO: error handling
  // TODO: Value.Convert?
  // TODO: Value.Default?

  return {
    check: compiled.Check,
    decode: (val) => {
      try {
        return { success: true as const, value: compiled.Decode(val) }
      } catch (error) {
        return { success: false as const, error }
      }
    },
    encode: (val) => {
      try {
        return { success: true as const, value: compiled.Encode(val) }
      } catch (error) {
        return { success: false as const, error }
      }
    },
  }
}
