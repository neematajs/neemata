import {
  type BigIntOptions,
  type IntegerOptions,
  type NumberOptions,
  type TBigInt,
  type TInteger,
  type TNumber,
  Type,
} from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class NumberType extends BaseType<
  TNumber,
  { options: NumberOptions },
  number
> {
  static factory(options: NumberOptions = {}) {
    return new NumberType(Type.Number(options), { options })
  }

  positive() {
    return this.min(0, true)
  }

  negative() {
    return this.max(0, true)
  }

  max(value: number, exclusive?: true) {
    return NumberType.factory({
      ...this.props.options,
      maximum: value,
      ...(!exclusive ? {} : { exclusiveMaximum: value }),
    })
  }

  min(value: number, exclusive?: true) {
    return NumberType.factory({
      ...this.props.options,
      minimum: value,
      ...(!exclusive ? {} : { exclusiveMinimum: value }),
    })
  }
}

export class IntegerType extends BaseType<
  TInteger,
  { options: IntegerOptions },
  number
> {
  static factory(options: IntegerOptions = {}) {
    return new IntegerType(Type.Integer(options), { options })
  }

  positive() {
    return this.min(0, true)
  }

  negative() {
    return this.max(0, true)
  }

  max(value: number, exclusive?: true) {
    return IntegerType.factory({
      ...this.props.options,
      maximum: value,
      ...(!exclusive ? {} : { exclusiveMaximum: value }),
    })
  }

  min(value: number, exclusive?: true) {
    return IntegerType.factory({
      ...this.props.options,
      minimum: value,
      ...(!exclusive ? {} : { exclusiveMinimum: value }),
    })
  }
}

// TODO: this is not json schema compatible
export class BigIntType extends BaseType<
  TBigInt,
  { options: BigIntOptions },
  bigint
> {
  static factory(options: BigIntOptions = {}) {
    return new BigIntType(
      Type.BigInt(options),
      { options },
      { encode: (value) => `${value}` },
    )
  }

  positive() {
    return this.min(0n, true)
  }

  negative() {
    return this.max(0n, true)
  }

  max(value: bigint, exclusive?: true) {
    return BigIntType.factory({
      ...this.props.options,
      maximum: value,
      ...(!exclusive ? {} : { exclusiveMaximum: value }),
    })
  }

  min(value: bigint, exclusive?: true) {
    return BigIntType.factory({
      ...this.props.options,
      minimum: value,
      ...(!exclusive ? {} : { exclusiveMinimum: value }),
    })
  }
}
