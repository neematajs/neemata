import {
  Kind,
  type SchemaOptions,
  type TSchema,
  TypeRegistry,
} from '@sinclair/typebox/type'

const UnionEnumKind = 'UnionEnum'

// Ref: https://github.com/sinclairzx81/typebox/blob/master/example/prototypes/union-enum.ts

// -------------------------------------------------------------------------------------
// TUnionEnum
// -------------------------------------------------------------------------------------
export interface TUnionEnum<T extends (string | number)[]> extends TSchema {
  [Kind]: typeof UnionEnumKind
  static: T[number]
  enum: T
}

// -------------------------------------------------------------------------------------
// UnionEnum
// -------------------------------------------------------------------------------------
/** `[Experimental]` Creates a Union type with a `enum` schema representation  */
export function UnionEnum<T extends (string | number)[]>(
  values: [...T],
  options: SchemaOptions = {},
) {
  function UnionEnumCheck(
    schema: TUnionEnum<(string | number)[]>,
    value: unknown,
  ) {
    return (
      (typeof value === 'string' || typeof value === 'number') &&
      schema.enum.includes(value)
    )
  }

  if (!TypeRegistry.Has(UnionEnumKind))
    TypeRegistry.Set(UnionEnumKind, UnionEnumCheck)

  return { ...options, [Kind]: UnionEnumKind, enum: values } as TUnionEnum<T>
}
