import {
  Kind,
  type SchemaOptions,
  type TSchema,
  TypeRegistry,
} from '@sinclair/typebox/type'

const NativeEnumKind = 'NativeEnum'

// -------------------------------------------------------------------------------------
// TNativeEnum
// -------------------------------------------------------------------------------------
export interface TNativeEnum<T extends Record<string, string>> extends TSchema {
  [Kind]: typeof NativeEnumKind
  static: T[keyof T][]
  enum: T[keyof T][]
}

// -------------------------------------------------------------------------------------
// NativeEnum
// -------------------------------------------------------------------------------------
/** `[Experimental]` Creates a Union type with a `enum` schema representation  */
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
