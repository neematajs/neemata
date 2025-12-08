import type { ProtocolBlobInterface } from './blob.ts'
import { kBlobKey } from './constants.ts'

export const isBlobInterface = <T extends ProtocolBlobInterface>(
  value: any,
): value is T => {
  return (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    kBlobKey in value
  )
}
