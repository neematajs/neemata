import { type TLiteral, type TLiteralValue, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class LiteralType<
  T extends TLiteralValue = TLiteralValue,
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TLiteral<T>, N, O> {
  constructor(
    readonly value: T,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(Type.Literal(value), nullable, optional)
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new LiteralType(this.value, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new LiteralType(this.value, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new LiteralType(this.value, ...args)
  }
}
