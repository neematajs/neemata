import { KindGuard, type TSchema } from '@sinclair/typebox'

import { ServiceKind, type TServiceContract } from '../schemas/service.ts'

export const IsService = (schema: TSchema): schema is TServiceContract =>
  KindGuard.IsKindOf(schema, ServiceKind)
