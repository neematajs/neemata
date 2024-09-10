import {
  type IntegerOptions,
  type NumberOptions,
  type TInteger,
  type TNumber,
  Type,
} from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class NumberType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TNumber, N, O, D, NumberOptions> {
  constructor(
    protected readonly options: NumberOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(options: NumberOptions): TNumber {
    return Type.Number(options)
  }

  nullable() {
    return new NumberType(...this._with({ isNullable: true }))
  }

  optional() {
    return new NumberType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new NumberType(...this._with({ isNullable: true, isOptional: true }))
  }

  default(value: number) {
    return new NumberType(
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new NumberType(...this._with({ options: { description } }))
  }

  examples(...examples: [number, ...number[]]) {
    return new NumberType(...this._with({ options: { examples } }))
  }

  positive() {
    return this.min(0, true)
  }

  negative() {
    return this.max(0, true)
  }

  max(value: number, exclusive?: true) {
    return new NumberType(
      ...this._with({
        options: {
          maximum: value,
          ...(exclusive ? {} : { exclusiveMaximum: value }),
        },
      }),
    )
  }

  min(value: number, exclusive?: true) {
    return new NumberType(
      ...this._with({
        options: {
          minimum: value,
          ...(exclusive ? {} : { exclusiveMinimum: value }),
        },
      }),
    )
  }
}

export class IntegerType<
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TInteger, N, O, D, IntegerOptions> {
  constructor(
    options: IntegerOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(options: IntegerOptions): TInteger {
    return Type.Integer(options)
  }

  nullable() {
    return new IntegerType(...this._with({ isNullable: true }))
  }

  optional() {
    return new IntegerType(...this._with({ isOptional: true }))
  }

  nullish() {
    return new IntegerType(
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: number) {
    return new IntegerType(
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new IntegerType(...this._with({ options: { description } }))
  }

  examples(...examples: [number, ...number[]]) {
    return new IntegerType(...this._with({ options: { examples } }))
  }

  positive() {
    return this.min(0, true)
  }

  negative() {
    return this.max(0, true)
  }

  max(value: number, exclusive?: true) {
    return new IntegerType(
      ...this._with({
        options: {
          maximum: value,
          ...(exclusive ? {} : { exclusiveMaximum: value }),
        },
      }),
    )
  }

  min(value: number, exclusive?: true) {
    return new IntegerType(
      ...this._with({
        options: {
          minimum: value,
          ...(exclusive ? {} : { exclusiveMinimum: value }),
        },
      }),
    )
  }
}
