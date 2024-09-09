import { type SchemaOptions, type TNever, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class NeverType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TNever, N, O, D> {
  constructor(options: SchemaOptions = {}) {
    super(options, false as N, false as O, false as D)
  }

  protected _constructSchema(options: SchemaOptions): TNever {
    return Type.Never(options)
  }

  nullable(): NeverType<true, O, D> {
    throw new Error('NeverType cannot be nullable')
  }

  optional(): NeverType<N, true, D> {
    throw new Error('NeverType cannot be optional')
  }

  nullish(): NeverType<true, true, D> {
    throw new Error('NeverType cannot be nullish')
  }

  default(): NeverType<N, O, true> {
    throw new Error('NeverType cannot have a default value')
  }

  description(description: string): NeverType<N, O, D> {
    return new NeverType({ ...this.options, description })
  }

  examples(): NeverType<N, O, D> {
    throw new Error('NeverType cannot have examples')
  }
}
