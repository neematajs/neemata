import {
  type SchemaOptions,
  type TNull,
  type TOptional,
  type TSchema,
  type TUndefined,
  type TUnion,
  Type,
} from '@sinclair/typebox/type'

export type TNullable<T extends TSchema> = TUnion<[T, TNull]>
export const Nullable = <T extends TSchema>(
  schema: T,
  options: SchemaOptions = {},
) => {
  const { default: _default } = schema

  return Type.Union([schema, Type.Null()], {
    default: _default,
    ...options,
  })
}

export type TOptionalUndefined<T extends TSchema> = TOptional<
  TUnion<[T, TUndefined]>
>
