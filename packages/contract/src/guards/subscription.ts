import { KindGuard, type TSchema } from '@sinclair/typebox'
import {
  SubscriptionKind,
  type TSubscriptionContract,
} from '../schemas/subscription'

export const IsSubscription = (
  schema: TSchema,
): schema is TSubscriptionContract =>
  KindGuard.IsKindOf(schema, SubscriptionKind)
