import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import { isBlobInterface } from '@nmtjs/protocol'
import { any, custom } from 'zod/mini'

import { CustomType } from './custom.ts'

export interface BlobOptions {
  maxSize?: number
  contentType?: string
}

/** Creates the Zod-backed blob codec so it composes with other `t.*` types. */
export const BlobType = (
  options: BlobOptions = {},
): CustomType<ProtocolBlobInterface> =>
  CustomType.factory({
    decode: {
      type: custom<ProtocolBlobInterface>(
        isBlobInterface,
        'Value is not a Neemata Blob. Make sure to use transport that supports encoded streams.',
      ),
      transform: (value) => value,
    },
    encode: { type: any(), transform: (value) => value },
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
