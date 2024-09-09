import { type TInteger, type TNumber, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class NumberType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TNumber, N, O> {
  constructor(
    schema: TNumber = Type.Number(),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  positive() {
    return new NumberType(
      Type.Number({ ...this._schema, minimum: 0, exclusiveMinimum: 0 }),
      ...this._isNullableOptional,
    )
  }

  negative() {
    return new NumberType(
      Type.Number({ ...this._schema, maximum: 0, exclusiveMaximum: 0 }),
      ...this._isNullableOptional,
    )
  }

  max(value: number, exclusive?: true) {
    return new NumberType(
      Type.Number({
        ...this._schema,
        maximum: value,
        ...(exclusive ? {} : { exclusiveMaximum: value }),
      }),
      ...this._isNullableOptional,
    )
  }

  min(value: number, exclusive?: true) {
    return new NumberType(
      Type.Number({
        ...this._schema,
        minimum: value,
        ...(exclusive ? {} : { exclusiveMinimum: value }),
      }),
      ...this._isNullableOptional,
    )
  }

  nullable() {
    return new NumberType(...this._nullable())
  }

  optional() {
    return new NumberType(...this._optional())
  }

  nullish() {
    return new NumberType(...this._nullish())
  }
}

export class IntegerType<
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TInteger, N, O> {
  constructor(
    schema: TInteger = Type.Integer(),
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(schema, nullable, optional)
  }

  positive() {
    return new IntegerType(
      Type.Integer({ ...this._schema, minimum: 0, exclusiveMinimum: 0 }),
      ...this._isNullableOptional,
    )
  }

  negative() {
    return new IntegerType(
      Type.Integer({ ...this._schema, maximum: 0, exclusiveMaximum: 0 }),
      ...this._isNullableOptional,
    )
  }

  max(value: number, exclusive?: true) {
    return new IntegerType(
      Type.Integer({
        ...this._schema,
        maximum: value,
        ...(exclusive ? {} : { exclusiveMaximum: value }),
      }),
      ...this._isNullableOptional,
    )
  }

  min(value: number, exclusive?: true) {
    return new IntegerType(
      Type.Integer({
        ...this._schema,
        minimum: value,
        ...(exclusive ? {} : { exclusiveMinimum: value }),
      }),
      ...this._isNullableOptional,
    )
  }

  nullable() {
    return new IntegerType(...this._nullable())
  }

  optional() {
    return new IntegerType(...this._optional())
  }

  nullish() {
    return new IntegerType(...this._nullish())
  }
}
