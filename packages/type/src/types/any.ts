import { type TAny, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class AnyType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TAny, N, O> {
  constructor(
    schema = Type.Any(),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  nullable() {
    return new AnyType(...this._nullable())
  }

  optional() {
    return new AnyType(...this._optional())
  }

  nullish() {
    return new AnyType(...this._nullish())
  }
}
