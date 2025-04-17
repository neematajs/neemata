import { literal, type ZodMiniLiteral } from '@zod/mini'
import { BaseType, type PrimitiveValueType } from './base.ts'

export class LiteralType<
  T extends PrimitiveValueType = PrimitiveValueType,
> extends BaseType<ZodMiniLiteral<T>, ZodMiniLiteral<T>, { value: T }> {
  static factory<T extends PrimitiveValueType>(value: T) {
    return new LiteralType<T>({
      encodedZodType: literal(value),
      props: { value },
    })
  }
}
