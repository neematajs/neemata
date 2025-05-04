import type { ArrayMap } from '@nmtjs/common'
import { tuple, type ZodMiniTuple } from '@zod/mini'
import { BaseType } from './base.ts'

export class TupleType<
  T extends readonly [BaseType, ...BaseType[]] = readonly [
    BaseType,
    ...BaseType[],
  ],
  R extends BaseType | null = BaseType | null,
> extends BaseType<
  R extends BaseType
    ? ZodMiniTuple<ArrayMap<T, 'encodedZodType'>, R['encodedZodType']>
    : ZodMiniTuple<ArrayMap<T, 'encodedZodType'>, null>,
  R extends BaseType
    ? ZodMiniTuple<ArrayMap<T, 'decodedZodType'>, R['decodedZodType']>
    : ZodMiniTuple<ArrayMap<T, 'decodedZodType'>, null>,
  { elements: T; rest?: R }
> {
  static factory<
    T extends readonly [BaseType, ...BaseType[]],
    R extends BaseType | null = null,
  >(elements: T, rest: R = null as R) {
    const encoded = elements.map((el) => el.encodedZodType)
    const decoded = elements.map((el) => el.decodedZodType)
    return new TupleType<T, R>({
      // @ts-expect-error
      encodedZodType: tuple(encoded, rest?.encodedZodType),
      // @ts-expect-error
      decodedZodType: tuple(decoded, rest?.decodedZodType),
      props: { elements, rest },
    })
  }
}
