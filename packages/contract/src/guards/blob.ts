import { KindGuard, type TSchema } from '@sinclair/typebox'
import { BlobKind, type TBlob } from '../schemas/blob.ts'

export const IsBlob = (schema: TSchema): schema is TBlob =>
  KindGuard.IsKindOf(schema, BlobKind)
