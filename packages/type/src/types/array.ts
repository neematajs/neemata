import type { core, ZodMiniArray } from 'zod/mini'
import { length, maxLength, minLength, array as zodArray } from 'zod/mini'

import { BaseType } from './base.ts'

type Check = core.CheckFn<any[]> | core.$ZodCheck<any[]>

export class ArrayType<T extends BaseType = BaseType> extends BaseType<
  ZodMiniArray<T['encodeZodType']>,
  ZodMiniArray<T['decodeZodType']>,
  { element: T }
> {
  static factory<T extends BaseType>(element: T, ...checks: Check[]) {
    return new ArrayType<T>({
      encodeZodType: zodArray(element.encodeZodType).check(...checks),
      decodeZodType: zodArray(element.decodeZodType).check(...checks),
      params: { checks },
      props: { element },
    })
  }

  min(value: number) {
    const check = minLength(value)
    return ArrayType.factory<T>(
      this.props.element,
      ...this.params.checks,
      check,
    )
  }

  max(value: number) {
    const check = maxLength(value)
    return ArrayType.factory<T>(
      this.props.element,
      ...this.params.checks,
      check,
    )
  }

  length(value: number) {
    const check = length(value)
    return ArrayType.factory<T>(
      this.props.element,
      ...this.params.checks,
      check,
    )
  }
}

export const array = ArrayType.factory
