import { KindGuard, type TSchema } from '@sinclair/typebox'

import type { TDownStreamContract, TUpStreamContract } from '../contract.ts'
import { DownStreamKind, UpStreamKind } from '../schemas/streams.ts'

export const IsDownStream = (schema: TSchema): schema is TDownStreamContract =>
  KindGuard.IsKindOf(schema, DownStreamKind)

export const IsUpStream = (schema: TSchema): schema is TUpStreamContract =>
  KindGuard.IsKindOf(schema, UpStreamKind)
