import type { ZodMiniLiteral } from 'zod/mini'
import { literal as zodLiteral } from 'zod/mini'

import type { PrimitiveValueType } from './base.ts'
import { BaseType } from './base.ts'

export class LiteralType<
  T extends PrimitiveValueType = PrimitiveValueType,
> extends BaseType<ZodMiniLiteral<T>, ZodMiniLiteral<T>, { value: T }> {
  static factory<T extends PrimitiveValueType>(value: T) {
    return new LiteralType<T>({
      encodeZodType: zodLiteral(value),
      props: { value },
    })
  }
}

export const literal = LiteralType.factory
