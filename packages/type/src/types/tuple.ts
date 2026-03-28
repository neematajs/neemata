import type { ArrayMap } from '@nmtjs/common'
import type { ZodMiniTuple } from 'zod/mini'
import { tuple as zodTuple } from 'zod/mini'

import { BaseType } from './base.ts'

export class TupleType<
  T extends readonly [BaseType, ...BaseType[]] = readonly [
    BaseType,
    ...BaseType[],
  ],
  R extends BaseType | null = BaseType | null,
> extends BaseType<
  R extends BaseType
    ? ZodMiniTuple<ArrayMap<T, 'encodeZodType'>, R['encodeZodType']>
    : ZodMiniTuple<ArrayMap<T, 'encodeZodType'>, null>,
  R extends BaseType
    ? ZodMiniTuple<ArrayMap<T, 'decodeZodType'>, R['decodeZodType']>
    : ZodMiniTuple<ArrayMap<T, 'decodeZodType'>, null>,
  { elements: T; rest?: R }
> {
  static factory<
    T extends readonly [BaseType, ...BaseType[]],
    R extends BaseType | null = null,
  >(elements: T, rest: R = null as R) {
    const encode = elements.map((el) => el.encodeZodType)
    const decode = elements.map((el) => el.decodeZodType)
    return new TupleType<T, R>({
      // @ts-expect-error
      encodeZodType: zodTuple(encode, rest?.encodeZodType),
      // @ts-expect-error
      decodeZodType: zodTuple(decode, rest?.decodeZodType),
      props: { elements, rest },
    })
  }
}

export const tuple = TupleType.factory
