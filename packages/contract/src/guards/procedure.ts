import { KindGuard, type TSchema } from '@sinclair/typebox'
import { ProcedureKind, type TProcedureContract } from '../schemas/procedure'

export const IsProcedure = (schema: TSchema): schema is TProcedureContract =>
  KindGuard.IsKindOf(schema, ProcedureKind)
