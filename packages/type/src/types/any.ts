import type { ZodMiniAny } from 'zod/mini'
import { any as zodAny } from 'zod/mini'

import { BaseType } from './base.ts'

export class AnyType extends BaseType<ZodMiniAny> {
  static factory() {
    const schema = zodAny()
    return new AnyType({ encodeZodType: schema, runtimeZodType: schema })
  }
}

export const any = AnyType.factory
