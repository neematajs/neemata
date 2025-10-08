import type { ZodMiniNever } from 'zod/mini'
import { never as zodNever } from 'zod/mini'

import { BaseType } from './base.ts'

export class NeverType extends BaseType<ZodMiniNever> {
  static factory() {
    return new NeverType({ encodeZodType: zodNever() })
  }
}

export const never = NeverType.factory
