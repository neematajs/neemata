import { type TBoolean, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class BooleanType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TBoolean, N, O> {
  constructor(
    schema: TBoolean = Type.Boolean(),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  nullable() {
    return new BooleanType(...this._nullable())
  }

  optional() {
    return new BooleanType(...this._optional())
  }

  nullish() {
    return new BooleanType(...this._nullish())
  }
}
