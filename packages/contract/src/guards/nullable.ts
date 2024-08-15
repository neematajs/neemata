import {
  KindGuard,
  type TNull,
  type TSchema,
  type TUnion,
} from '@sinclair/typebox'

export const IsNullable = (
  schema: TSchema,
): schema is TUnion<[TSchema, TNull]> =>
  KindGuard.IsUnion(schema) &&
  schema.anyOf.length === 2 &&
  KindGuard.IsNull(schema.anyOf[1]) &&
  KindGuard.IsSchema(schema.anyOf[0])
