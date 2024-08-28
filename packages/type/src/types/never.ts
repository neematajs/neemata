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

  nullable(): NeverType<true, O> {
    throw new Error('NeverType cannot be nullable')
  }

  optional(): NeverType<N, true> {
    throw new Error('NeverType cannot be optional')
  }

  nullish(): NeverType<true, true> {
    throw new Error('NeverType cannot be nullish')
  }
}
