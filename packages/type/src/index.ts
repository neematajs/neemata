import { en } from 'zod/locales'
import { config } from 'zod/mini'

import * as type from './types/_type.ts'

export type { Schema, WireSchema } from '@nmtjs/common/schema'
export * from './types/_convert.ts'
export * from './types/_utils.ts'
export * from './types/base.ts'
export { BlobType as blobType } from './types/blob.ts'

export { type, type as t }
export default type

export function registerDefaultLocale() {
  config(en())
}
