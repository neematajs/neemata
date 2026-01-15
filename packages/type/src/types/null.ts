import type { ZodMiniNull } from 'zod/mini'
import { null as zodNull } from 'zod/mini'

import { BaseType } from './base.ts'

export class NullType extends BaseType<ZodMiniNull> {
  static factory() {
    return new NullType({ encodeZodType: zodNull() })
  }
}

const _null = NullType.factory

export { _null as null }
