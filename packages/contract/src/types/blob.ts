import type { ProtocolBlobInterface } from '@nmtjs/protocol/common'
import { t, zod } from '@nmtjs/type'

export interface BlobOptions {
  maxSize?: number
  contentType?: string
}

export const BlobType = (options: BlobOptions = {}) =>
  t.custom<ProtocolBlobInterface>({
    decode: (value) => {
      // TODO: this should be registered separately for server and client
      // ref: https://github.com/sinclairzx81/typebox/issues/977
      if ('metadata' in value) {
        if (options.maxSize) {
          const size = (value as ProtocolBlobInterface).metadata.size
          if (size === -1 || size > options.maxSize) {
            throw new Error('Blob size unknown or exceeds maximum allowed size')
          }
        }
      }
      return value
    },
    encode: (value) => value,
    type: zod.any(),
  })
