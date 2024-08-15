import { ApiBlob, type ApiBlobInterface } from '@nmtjs/common'
import {
  Kind,
  type TSchema,
  Type,
  TypeBoxError,
  TypeRegistry,
} from '@sinclair/typebox/type'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const BlobKind = 'ApiBlob'

export type BlobOptions = {
  maxSize?: number
  contentType?: string
}

export interface TBlob extends TSchema {
  [Kind]: typeof BlobKind
  type: 'neemata:blob'
  static: ApiBlobInterface
  maxSize?: BlobOptions['maxSize']
  contentType?: BlobOptions['contentType']
}

export const BlobType = (
  options: BlobOptions = {},
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  if (!TypeRegistry.Has(BlobKind)) {
    TypeRegistry.Set(BlobKind, (schema: TBlob, value) => {
      return 'metadata' in (value as any)
    })
  }

  return Type.Transform(
    createSchema<TBlob>({
      ...schemaOptions,
      [Kind]: BlobKind,
      type: 'neemata:blob',
      ...options,
    }),
  )
    .Decode((value) => {
      if ('metadata' in value) {
        if (options.maxSize) {
          const size = (value as ApiBlobInterface).metadata.size
          if (size === -1 || size > options.maxSize) {
            throw new TypeBoxError(
              'Blob size unknown or exceeds maximum allowed size',
            )
          }
        }
      }
      return value
    })
    .Encode((value) => value) as unknown as TBlob
}
