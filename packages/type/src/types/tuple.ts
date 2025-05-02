import { type core, tuple, type ZodMiniTuple } from '@zod/mini'
import { BaseType } from './base.ts'

type Check = core.CheckFn<any[]> | core.$ZodCheck<any[]>

export class TupleType<
  T extends readonly BaseType[] = readonly BaseType[],
> extends BaseType<
  ZodMiniTuple<core.utils.Flatten<T[number]['encodedZodType'][]>>,
  ZodMiniTuple<core.utils.Flatten<T[number]['decodedZodType'][]>>,
  { elements: T }
> {
  static factory<T extends readonly BaseType[]>(
    elements: T,
    ...checks: Check[]
  ) {
    return new TupleType<T>({
      //@ts-expect-error
      encodedZodType: tuple(elements.map((el) => el.encodedZodType)).check(
        ...checks,
      ),
      //@ts-expect-error
      decodedZodType: tuple(elements.map((el) => el.decodedZodType)).check(
        ...checks,
      ),
      params: { checks },
      props: { elements },
    })
  }
}
