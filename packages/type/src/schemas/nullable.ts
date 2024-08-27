import {
  type SchemaOptions,
  type TNull,
  type TSchema,
  type TUnion,
  Type,
} from '@sinclair/typebox/type'

export type TNullable<T extends TSchema> = TUnion<[T, TNull]>
export const Nullable = <T extends TSchema>(
  schema: T,
  options: SchemaOptions = {},
) => Type.Union([schema, Type.Null()], options)
