import { type SchemaOptions, type TAny, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class AnyType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TAny, N, O, D, SchemaOptions> {
  constructor(
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(options: SchemaOptions): TAny {
    return Type.Any(options)
  }

  nullable() {
    return new AnyType(...this._with({ isNullable: true }))
  }

  optional() {
    return new AnyType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new AnyType(...this._with({ isNullable: true, isOptional: true }))
  }

  default(value: any) {
    return new AnyType(
      ...this._with({
        options: { default: value },
        hasDefault: true,
      }),
    )
  }

  description(description: string) {
    return new AnyType(...this._with({ options: { description } }))
  }

  examples(...examples: [any, ...any[]]) {
    return new AnyType(...this._with({ options: { examples } }))
  }
}
