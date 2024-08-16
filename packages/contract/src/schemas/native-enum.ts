import {
  Kind,
  type SchemaOptions,
  type TSchema,
  TypeRegistry,
} from '@sinclair/typebox/type'

export const NativeEnumKind = 'NativeEnum'
export interface TNativeEnum<T extends Record<string, string>> extends TSchema {
  [Kind]: typeof NativeEnumKind
  static: T[keyof T][]
  enum: T[keyof T][]
}

export function NativeEnum<T extends Record<string, string>>(
  value: T,
  options: SchemaOptions = {},
) {
  const values = Object.values(value)

  function NativeEnumCheck(schema: TNativeEnum<T>, value: unknown) {
    return typeof value === 'string' && schema.enum.includes(value as any)
  }

  if (!TypeRegistry.Has(NativeEnumKind))
    TypeRegistry.Set(NativeEnumKind, NativeEnumCheck)

  return { ...options, [Kind]: NativeEnumKind, enum: values } as TNativeEnum<T>
}
