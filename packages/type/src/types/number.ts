import {
  type core,
  gt,
  gte,
  int,
  lt,
  lte,
  number,
  type ZodMiniNumber,
} from '@zod/mini'
import { BaseType } from './base.ts'

type Check = core.CheckFn<number> | core.$ZodCheck<number>

export class NumberType extends BaseType<
  ZodMiniNumber<number>,
  ZodMiniNumber<number>,
  { checks: Check[] }
> {
  static factory(...checks: Check[]) {
    return new NumberType({
      encodedZodType: number().check(...checks),
    })
  }

  positive() {
    return NumberType.factory(...this.props.checks, gte(0))
  }

  negative() {
    return NumberType.factory(...this.props.checks, lte(0))
  }

  lt(value: number) {
    return NumberType.factory(...this.props.checks, lt(value))
  }

  lte(value: number) {
    return NumberType.factory(...this.props.checks, lte(value))
  }

  gte(value: number) {
    return NumberType.factory(...this.props.checks, gte(value))
  }

  gt(value: number) {
    return NumberType.factory(...this.props.checks, gt(value))
  }
}

export class IntegerType extends NumberType {
  static factory(...checks: Check[]) {
    return NumberType.factory(...checks, int())
  }
}
