import { type SchemaOptions, type TBoolean, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class BooleanType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TBoolean, N, O, D> {
  constructor(
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(options: SchemaOptions): TBoolean {
    return Type.Boolean(options)
  }

  nullable() {
    return new BooleanType(...this._with({ isNullable: true }))
  }

  optional() {
    return new BooleanType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new BooleanType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: boolean) {
    return new BooleanType(
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new BooleanType(...this._with({ options: { description } }))
  }

  examples(...examples: [boolean, ...boolean[]]) {
    return new BooleanType(...this._with({ options: { examples } }))
  }
}
