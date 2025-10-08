import type { ZodMiniAny } from 'zod/mini'
import { any as zodAny } from 'zod/mini'

import { BaseType } from './base.ts'

export class AnyType extends BaseType<ZodMiniAny> {
  static factory() {
    return new AnyType({ encodeZodType: zodAny() })
  }
}

export const any = AnyType.factory
