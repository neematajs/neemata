import { type TLiteral, type TLiteralValue, Type } from '@sinclair/typebox'
import { BaseType, type ConstantType } from './base.ts'

export class LiteralType<
  T extends TLiteralValue = TLiteralValue,
> extends BaseType<TLiteral<T>> {
  _!: ConstantType<this['schema']>

  static factory<T extends TLiteralValue>(value: T) {
    return new LiteralType<T>(Type.Literal(value))
  }
}
