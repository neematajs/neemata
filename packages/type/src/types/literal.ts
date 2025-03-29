import { type TLiteral, type TLiteralValue, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class LiteralType<
  T extends TLiteralValue = TLiteralValue,
> extends BaseType<TLiteral<T>, { value: TLiteralValue }, T> {
  static factory<T extends TLiteralValue>(value: T) {
    return new LiteralType<T>(Type.Literal(value), { value })
  }
}
