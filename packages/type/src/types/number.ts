import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'
import { CustomType, TransformType } from './custom.ts'

type Check = zod.core.CheckFn<number> | zod.core.$ZodCheck<number>

export class NumberType extends BaseType<
  zod.ZodMiniNumber<number>,
  zod.ZodMiniNumber<number>
> {
  static factory(...checks: Check[]) {
    return new NumberType({
      encodedZodType: zod.number().check(...checks),
      params: { checks },
    })
  }

  positive() {
    return NumberType.factory(...this.params.checks, zod.gte(0))
  }

  negative() {
    return NumberType.factory(...this.params.checks, zod.lte(0))
  }

  lt(value: number) {
    return NumberType.factory(...this.params.checks, zod.lt(value))
  }

  lte(value: number) {
    return NumberType.factory(...this.params.checks, zod.lte(value))
  }

  gte(value: number) {
    return NumberType.factory(...this.params.checks, zod.gte(value))
  }

  gt(value: number) {
    return NumberType.factory(...this.params.checks, zod.gt(value))
  }
}

export class IntegerType extends NumberType {
  static factory(...checks: Check[]) {
    return NumberType.factory(...checks, zod.int())
  }
}

export class BigIntType extends TransformType<
  bigint,
  zod.ZodMiniString<string>
> {
  static factory() {
    return CustomType.factory<bigint, zod.ZodMiniString<string>>({
      decode: (value) => BigInt(value),
      encode: (value) => value.toString(),
      type: zod.string().check(zod.regex(/^-?\d+$/)),
      error: 'Invalid bigint format',
    })
  }
}

export const number = NumberType.factory
export const integer = IntegerType.factory
export const bigInt = BigIntType.factory
