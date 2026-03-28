import type { ZodMiniType } from 'zod/mini'

import type { BaseType } from './base.ts'

export type AnyCompatibleType<Encoded = any, Decoded = any> = BaseType<
  ZodMiniType<any, Decoded>,
  ZodMiniType<any, Encoded>
>
