import type { ZodMiniUnknown } from 'zod/mini'
import { unknown as zodUnknown } from 'zod/mini'

import { BaseType } from './base.ts'

export class UnknownType extends BaseType<ZodMiniUnknown> {
  static factory() {
    return new UnknownType({ encodeZodType: zodUnknown() })
  }
}

export const unknown = UnknownType.factory
