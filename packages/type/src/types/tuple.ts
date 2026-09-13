import type { ArrayMap } from '@nmtjs/common'
import type { ZodMiniTuple } from 'zod/mini'
import { tuple as zodTuple } from 'zod/mini'

import { mapWireZodTypes } from './_metadata.ts'
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
  { elements: T; rest?: R },
  ZodMiniTuple<
    ArrayMap<T, 'runtimeZodType'>,
    R extends BaseType ? R['runtimeZodType'] : null
  >
> {
  static factory<
    T extends readonly [BaseType, ...BaseType[]],
    R extends BaseType | null = null,
  >(elements: T, rest: R = null as R) {
    const encode = elements.map((el) => el.encodeZodType)
    const decode = elements.map((el) => el.decodeZodType)
    const runtime = elements.map((el) => el.runtimeZodType) as ArrayMap<
      T,
      'runtimeZodType'
    >
    return new TupleType<T, R>({
      // @ts-expect-error
      encodeZodType: zodTuple(encode, rest?.encodeZodType),
      // @ts-expect-error
      decodeZodType: zodTuple(decode, rest?.decodeZodType),
      wireZodTypes: mapWireZodTypes((side) => {
        const items = elements.map((type) => type.wireZodTypes[side]) as [
          BaseType['wireZodTypes']['input'],
          ...BaseType['wireZodTypes']['input'][],
        ]
        return rest ? zodTuple(items, rest.wireZodTypes[side]) : zodTuple(items)
      }),
      // The branch follows R, but TypeScript cannot narrow that generic conditional.
      runtimeZodType: (rest
        ? zodTuple(runtime, rest.runtimeZodType)
        : zodTuple(runtime)) as TupleType<T, R>['runtimeZodType'],
      props: { elements, rest },
    })
  }
}

export const tuple = TupleType.factory
