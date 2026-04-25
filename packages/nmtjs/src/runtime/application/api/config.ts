import type { MetadataKind } from '@nmtjs/core'
import { createMeta } from '@nmtjs/core'

import type { ApiMetaContext } from './meta.ts'

export interface RuntimeConfig {
  serializeOutput?: boolean
}

export const config = createMeta<
  RuntimeConfig,
  MetadataKind.STATIC,
  ApiMetaContext
>()

export const defaultRuntimeConfig = Object.freeze({
  serializeOutput: true,
} satisfies Required<RuntimeConfig>)
