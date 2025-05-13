import type { ProtocolBlobInterface } from '@nmtjs/protocol/common'
import { t } from '@nmtjs/type'

export interface BlobOptions {
  maxSize?: number
  contentType?: string
}

export const BlobType = (options: BlobOptions = {}) =>
  t.custom<ProtocolBlobInterface>({
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
