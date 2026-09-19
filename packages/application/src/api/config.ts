import type { MetadataKind } from '@nmtjs/core'

import { createMeta } from './meta.ts'

export interface RuntimeConfig {
  serializeOutput?: boolean
}

export const config = createMeta<RuntimeConfig, MetadataKind.STATIC>()

export const defaultRuntimeConfig = Object.freeze({
  serializeOutput: true,
} satisfies Required<RuntimeConfig>)
