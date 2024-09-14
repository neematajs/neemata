import {
  Extends,
  type SchemaOptions,
  type TLiteral,
  type TLiteralValue,
  Type,
} from '@sinclair/typebox'
import { BaseType } from './base.ts'

export type AnyLiteralType<T extends TLiteralValue = any> = LiteralType<
  T,
  boolean,
  boolean,
  boolean
>
export class LiteralType<
  T extends TLiteralValue,
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TLiteral<T>, N, O, D> {
  constructor(
    protected readonly value: T,
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, value)
  }

  protected _constructSchema(options: SchemaOptions, value: T): TLiteral<T> {
    return Type.Literal(value, options)
  }

  nullable() {
    return new LiteralType(this.value, this.options, true, this.isOptional)
  }

  optional() {
    return new LiteralType(this.value, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new LiteralType(
      this.value,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: T = this.value) {
    return new LiteralType(
      this.value,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new LiteralType(
      this.value,
      ...this._with({ options: { description } }),
    )
  }

  examples(...examples: [T, ...T[]]) {
    return new LiteralType(this.value, ...this._with({ options: { examples } }))
  }
}
