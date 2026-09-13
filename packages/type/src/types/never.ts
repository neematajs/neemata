import type { ZodMiniNever } from 'zod/mini'
import { never as zodNever } from 'zod/mini'

import { BaseType } from './base.ts'

export class NeverType extends BaseType<ZodMiniNever> {
  static factory() {
    const schema = zodNever()
    return new NeverType({ encodeZodType: schema, runtimeZodType: schema })
  }
}

export const never = NeverType.factory
