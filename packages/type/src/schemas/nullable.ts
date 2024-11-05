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
) => {
  const {
    default: _default,
    description,
    examples,
    readOnly,
    title,
    writeOnly,
  } = schema

  return Type.Union([schema, Type.Null()], {
    default: _default,
    description,
    examples,
    readOnly,
    title,
    writeOnly,
    ...options,
  })
}
