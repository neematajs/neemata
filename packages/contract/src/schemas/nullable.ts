import { type TSchema, Type } from '@sinclair/typebox/type'

export const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()])
