import type { ArrayMap } from '@nmtjs/common'
import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'

export class TupleType<
  T extends readonly [BaseType, ...BaseType[]] = readonly [
    BaseType,
    ...BaseType[],
  ],
  R extends BaseType | null = BaseType | null,
> extends BaseType<
  R extends BaseType
    ? zod.ZodMiniTuple<ArrayMap<T, 'encodedZodType'>, R['encodedZodType']>
    : zod.ZodMiniTuple<ArrayMap<T, 'encodedZodType'>, null>,
  R extends BaseType
    ? zod.ZodMiniTuple<ArrayMap<T, 'decodedZodType'>, R['decodedZodType']>
    : zod.ZodMiniTuple<ArrayMap<T, 'decodedZodType'>, null>,
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
      encodedZodType: zod.tuple(encoded, rest?.encodedZodType),
      // @ts-expect-error
      decodedZodType: zod.tuple(decoded, rest?.decodedZodType),
      props: { elements, rest },
    })
  }
}

export const tuple = TupleType.factory
