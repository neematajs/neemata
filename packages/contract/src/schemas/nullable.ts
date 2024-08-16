import { type SchemaOptions, type TSchema, Type } from '@sinclair/typebox/type'

export const Nullable = <T extends TSchema>(
  schema: T,
  options: SchemaOptions = {},
) => Type.Union([schema, Type.Null()], options)
