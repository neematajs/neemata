import { type TNever, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class NeverType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TNever, N, O> {
  constructor(
    schema = Type.Never(),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  // @ts-expect-error
  nullable() {
    throw new Error('NeverType cannot be nullable')
  }

  // @ts-expect-error
  optional() {
    throw new Error('NeverType cannot be optional')
  }

  // @ts-expect-error
  nullish() {
    throw new Error('NeverType cannot be nullish')
  }
}
