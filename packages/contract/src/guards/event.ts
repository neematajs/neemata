import { KindGuard, type TSchema } from '@sinclair/typebox'
import { EventKind, type TEventContract } from '../schemas/event'

export const IsEvent = (schema: TSchema): schema is TEventContract =>
  KindGuard.IsKindOf(schema, EventKind)
