import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import { isBlobInterface } from '@nmtjs/protocol'
import { CustomType } from '@nmtjs/type/custom'

export interface BlobOptions {
  maxSize?: number
  contentType?: string
}

export const BlobType = (
  options: BlobOptions = {},
): CustomType<ProtocolBlobInterface> =>
  CustomType.factory({
    decode: (value) => value,
    encode: (value) => value,
    validation: {
      decode(value, payload) {
        if (isBlobInterface(value)) {
          if (options.maxSize) {
            const size = value.metadata.size
            if (typeof size !== 'undefined' && size > options.maxSize) {
              payload.addIssue({
                code: 'custom',
                message: `Blob size unknown or exceeds maximum allowed size of ${options.maxSize} bytes`,
              })
            }
          }
        } else {
          payload.addIssue({
            code: 'custom',
            message:
              'Value is not a Neemata Blob. Make sure to use transport that supports encoded streams.',
          })
        }
      },
      encode(value, payload) {
        if (!isBlobInterface(value)) {
          payload.addIssue({
            code: 'custom',
            message:
              'Value is not a Neemata Blob. Make sure to use transport that supports encoded streams.',
          })
        }
      },
    },
  })
