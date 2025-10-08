import type { ZodMiniBoolean } from 'zod/mini'
import { boolean as zodBoolean } from 'zod/mini'

import { BaseType } from './base.ts'

export class BooleanType extends BaseType<ZodMiniBoolean<boolean>> {
  static factory() {
    return new BooleanType({ encodeZodType: zodBoolean() })
  }
}

export const boolean = BooleanType.factory
