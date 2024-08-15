import { KindGuard, type TSchema } from '@sinclair/typebox'
import { NativeEnumKind, type TNativeEnum } from '../schemas/native-enum.ts'

export const IsNativeEnum = (
  schema: TSchema,
): schema is TNativeEnum<Record<string, string>> =>
  KindGuard.IsKindOf(schema, NativeEnumKind)
