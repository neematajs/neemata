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
    ? ZodMiniTuple<
        {
          [K in keyof T]: T[K]['encodedZodType']
        },
        R['encodedZodType']
      >
    : ZodMiniTuple<
        {
          [K in keyof T]: T[K]['encodedZodType']
        },
        null
      >,
  R extends BaseType
    ? ZodMiniTuple<
        {
          [K in keyof T]: T[K]['decodedZodType']
        },
        R['decodedZodType']
      >
    : ZodMiniTuple<
        {
          [K in keyof T]: T[K]['decodedZodType']
        },
        null
      >,
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
