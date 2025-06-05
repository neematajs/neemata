import * as zod from 'zod/v4-mini'
import { BaseType, type PrimitiveValueType } from './base.ts'

export class LiteralType<
  T extends PrimitiveValueType = PrimitiveValueType,
> extends BaseType<zod.ZodMiniLiteral<T>, zod.ZodMiniLiteral<T>, { value: T }> {
  static factory<T extends PrimitiveValueType>(value: T) {
    return new LiteralType<T>({
      encodedZodType: zod.literal(value),
      props: { value },
    })
  }
}

export const literal = LiteralType.factory
