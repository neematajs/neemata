import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import { isBlobInterface } from '@nmtjs/protocol'
import { CustomType } from '@nmtjs/type/custom'

export interface BlobOptions {
  maxSize?: number
}

const NOT_A_BLOB =
  'Value is not a Neemata Blob. Make sure to use transport that supports encoded streams.'

export const BlobType = (
  options: BlobOptions = {},
): CustomType<ProtocolBlobInterface> =>
  CustomType.factory({
    decode: (value) => value,
    encode: (value) => value,
    validation: {
      decode(value, payload) {
        if (!isBlobInterface(value)) {
          payload.addIssue({ code: 'custom', message: NOT_A_BLOB })
          return
        }

        const { maxSize } = options
        const { size } = value.metadata
        // an unknown size cannot be checked here; transports cap the stream
        if (!maxSize || size === undefined || size <= maxSize) return

        payload.addIssue({
          code: 'custom',
          message: `Blob size exceeds maximum allowed size of ${maxSize} bytes`,
        })
      },
      encode(value, payload) {
        if (!isBlobInterface(value)) {
          payload.addIssue({ code: 'custom', message: NOT_A_BLOB })
        }
      },
    },
  })
