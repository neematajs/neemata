import type { ApiBlobInterface } from '@nmtjs/common'
import { t } from '@nmtjs/type'

export const BlobKind = 'ApiBlob'

export interface BlobOptions {
  maxSize?: number
  contentType?: string
}

export const blob = (options: BlobOptions = {}) =>
  t.custom<ApiBlobInterface>(
    (value) => {
      if ('metadata' in value) {
        if (options.maxSize) {
          const size = (value as ApiBlobInterface).metadata.size
          if (size === -1 || size > options.maxSize) {
            throw new Error('Blob size unknown or exceeds maximum allowed size')
          }
        }
      }
      return value
    },
    (value) => value,
  )