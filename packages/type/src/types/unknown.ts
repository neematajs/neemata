import type { ZodMiniUnknown } from 'zod/mini'
import { unknown as zodUnknown } from 'zod/mini'

import { BaseType } from './base.ts'

export class UnknownType extends BaseType<ZodMiniUnknown> {
  static factory() {
    const schema = zodUnknown()
    return new UnknownType({ encodeZodType: schema, runtimeZodType: schema })
  }
}

export const unknown = UnknownType.factory
