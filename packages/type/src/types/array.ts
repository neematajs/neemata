import {
  array,
  type core,
  length,
  maxLength,
  minLength,
  type ZodMiniArray,
} from '@zod/mini'
import { BaseType } from './base.ts'

type Check = core.CheckFn<any[]> | core.$ZodCheck<any[]>

export class ArrayType<T extends BaseType = BaseType> extends BaseType<
  ZodMiniArray<T['encodedZodType']>,
  ZodMiniArray<T['decodedZodType']>,
  { element: T; checks: Check[] }
> {
  static factory<T extends BaseType>(element: T, ...checks: Check[]) {
    return new ArrayType<T>({
      encodedZodType: array(element.encodedZodType).check(...checks),
      decodedZodType: array(element.decodedZodType).check(...checks),
      props: { element, checks },
    })
  }

  min(value: number) {
    const check = minLength(value)
    return ArrayType.factory<T>(this.props.element, ...this.props.checks, check)
  }

  max(value: number) {
    const check = maxLength(value)
    return ArrayType.factory<T>(this.props.element, ...this.props.checks, check)
  }

  length(value: number) {
    const check = length(value)
    return ArrayType.factory<T>(this.props.element, ...this.props.checks, check)
  }
}
