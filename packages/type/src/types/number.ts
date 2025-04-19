import {
  type core,
  gt,
  gte,
  int,
  lt,
  lte,
  number,
  regex,
  string,
  type ZodMiniNumber,
  type ZodMiniString,
} from '@zod/mini'
import { BaseType } from './base.ts'
import { CustomType, TransformType } from './custom.ts'

type Check = core.CheckFn<number> | core.$ZodCheck<number>

export class NumberType extends BaseType<
  ZodMiniNumber<number>,
  ZodMiniNumber<number>
> {
  static factory(...checks: Check[]) {
    return new NumberType({
      encodedZodType: number().check(...checks),
      params: { checks },
    })
  }

  positive() {
    return NumberType.factory(...this.params.checks, gte(0))
  }

  negative() {
    return NumberType.factory(...this.params.checks, lte(0))
  }

  lt(value: number) {
    return NumberType.factory(...this.params.checks, lt(value))
  }

  lte(value: number) {
    return NumberType.factory(...this.params.checks, lte(value))
  }

  gte(value: number) {
    return NumberType.factory(...this.params.checks, gte(value))
  }

  gt(value: number) {
    return NumberType.factory(...this.params.checks, gt(value))
  }
}

export class IntegerType extends NumberType {
  static factory(...checks: Check[]) {
    return NumberType.factory(...checks, int())
  }
}

export class BigIntType extends TransformType<bigint, ZodMiniString<string>> {
  static factory() {
    return CustomType.factory<bigint, ZodMiniString<string>>({
      decode: (value) => BigInt(value),
      encode: (value) => value.toString(),
      type: string().check(regex(/^-?\d+$/)),
      error: 'Invalid bigint format',
    })
  }
}
