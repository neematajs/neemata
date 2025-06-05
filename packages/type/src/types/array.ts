import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'

type Check = zod.core.CheckFn<any[]> | zod.core.$ZodCheck<any[]>

export class ArrayType<T extends BaseType = BaseType> extends BaseType<
  zod.ZodMiniArray<T['encodedZodType']>,
  zod.ZodMiniArray<T['decodedZodType']>,
  { element: T }
> {
  static factory<T extends BaseType>(element: T, ...checks: Check[]) {
    return new ArrayType<T>({
      encodedZodType: zod.array(element.encodedZodType).check(...checks),
      decodedZodType: zod.array(element.decodedZodType).check(...checks),
      params: { checks },
      props: { element },
    })
  }

  min(value: number) {
    const check = zod.minLength(value)
    return ArrayType.factory<T>(
      this.props.element,
      ...this.params.checks,
      check,
    )
  }

  max(value: number) {
    const check = zod.maxLength(value)
    return ArrayType.factory<T>(
      this.props.element,
      ...this.params.checks,
      check,
    )
  }

  length(value: number) {
    const check = zod.length(value)
    return ArrayType.factory<T>(
      this.props.element,
      ...this.params.checks,
      check,
    )
  }
}

export const array = ArrayType.factory
