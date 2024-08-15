import { KindGuard, type TSchema } from '@sinclair/typebox'
import { type TUnionEnum, UnionEnumKind } from '../schemas/union-enum.ts'

export const IsUnionEnum = (
  schema: TSchema,
): schema is TUnionEnum<(string | number)[]> =>
  KindGuard.IsKindOf(schema, UnionEnumKind)
