import { TypeCompiler } from '@sinclair/typebox/compiler'
import { TransformDecode, TransformEncode } from '@sinclair/typebox/value'
import type {
  StaticInputEncode,
  StaticOutputDecode,
  StaticOutputEncode,
} from './inference.ts'
import {
  type CloneOptions,
  type ValidationError,
  _applyDefaults,
  _parse,
  _traversErrors,
} from './runtime.ts'
import type { BaseType } from './types/base.ts'

export type Compiled<T extends BaseType = BaseType> = {
  check: (val: unknown) => val is StaticInputEncode<T['schema']>
  errors: (val: unknown) => ValidationError[]
  parse: (val: unknown, cloneOptions?: CloneOptions) => unknown
  applyDefaults: (val: unknown) => unknown
  /**
   * Requires to `check` before calling
   */
  decode: (val: unknown) => StaticOutputDecode<T['schema']>
  /**
   * Requires to `check` before calling
   */
  encode: (val: unknown) => StaticOutputEncode<T['schema']>
  /**
   * Requires to `check` before calling
   */
  decodeSafe: (
    val: unknown,
  ) =>
    | { success: true; value: StaticOutputDecode<T['schema']> }
    | { success: false; error: any }
  /**
   * Requires to `check` before calling
   */
  encodeSafe: (
    val: unknown,
  ) =>
    | { success: true; value: StaticOutputEncode<T['schema']> }
    | { success: false; error: any }
}

function compileType(type: BaseType) {
  const { schema } = type
  const compiled = TypeCompiler.Compile(schema)

  const check = (value: unknown) => compiled.Check(value)
  const applyDefaults = (value: unknown) => _applyDefaults(schema, value)
  const parse = (value: unknown, cloneOptions?: CloneOptions) =>
    _parse(schema, value, cloneOptions)
  const errors = (value: unknown) => _traversErrors(compiled.Errors(value))
  const decode = TransformDecode.bind(null, schema, compiled.References())
  const encode = TransformEncode.bind(null, schema, compiled.References())

  return {
    check,
    parse,
    errors,
    applyDefaults,
    decode,
    encode,
  }
}

export function compile<T extends BaseType>(type: T): Compiled<T> {
  const compiled = compileType(type)

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
