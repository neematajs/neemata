// biome-ignore lint/correctness/noUnusedImports: TSGO wants it
// biome-ignore assist/source/organizeImports: TSGO wants it
import type * as _ from 'zod/mini'

import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import { CustomType } from '@nmtjs/type/custom'

export interface BlobOptions {
  maxSize?: number
  contentType?: string
}

export const BlobType = (
  options: BlobOptions = {},
): CustomType<ProtocolBlobInterface> =>
  CustomType.factory({
    decode: (value) => {
      // TODO: here should be some validation logic to check if the value is an actual blob
      if ('metadata' in value) {
        if (options.maxSize) {
          const size = (value as ProtocolBlobInterface).metadata.size
          if (typeof size !== 'undefined' && size > options.maxSize) {
            throw new Error('Blob size unknown or exceeds maximum allowed size')
          }
        }
      }
      return value
    },
    encode: (value) => value,
  })
