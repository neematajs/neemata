import type { ArrayMap } from '@nmtjs/common'
import type {
  ZodMiniDiscriminatedUnion,
  ZodMiniIntersection,
  ZodMiniUnion,
} from 'zod/mini'
import {
  discriminatedUnion as zodDiscriminatedUnion,
  intersection as zodIntersection,
  union as zodUnion,
} from 'zod/mini'

import type { BaseTypeAny } from './base.ts'
import type { ObjectType, ObjectTypeProps } from './object.ts'
import { BaseType } from './base.ts'

export class UnionType<
  T extends readonly [BaseType, ...BaseType[]] = readonly [
    BaseType,
    ...BaseType[],
  ],
> extends BaseType<
  ZodMiniUnion<ArrayMap<T, 'encodeZodType'>>,
  ZodMiniUnion<ArrayMap<T, 'decodeZodType'>>,
  { options: T }
> {
  static factory<
    T extends readonly [BaseType, ...BaseType[]] = readonly [
      BaseType,
      ...BaseType[],
    ],
  >(...options: T) {
    const encode = options.map((t) => t.encodeZodType) as ArrayMap<
      T,
      'encodeZodType'
    >
    const decode = options.map((t) => t.decodeZodType) as ArrayMap<
      T,
      'decodeZodType'
    >
    return new UnionType<T>({
      encodeZodType: zodUnion(encode),
      decodeZodType: zodUnion(decode),
      props: { options },
    })
  }
}

export class IntersectionType<
  T extends readonly [BaseType, BaseType] = readonly [BaseType, BaseType],
> extends BaseType<
  ZodMiniIntersection<T[0]['encodeZodType'], T[1]['encodeZodType']>,
  ZodMiniIntersection<T[0]['decodeZodType'], T[1]['decodeZodType']>,
  { options: T }
> {
  static factory<
    T extends readonly [BaseType, BaseType] = readonly [BaseType, BaseType],
  >(...options: T) {
    const [first, second] = options
    return new IntersectionType<T>({
      encodeZodType: zodIntersection(first.encodeZodType, second.encodeZodType),
      decodeZodType: zodIntersection(first.decodeZodType, second.decodeZodType),
      props: { options },
    })
  }
}

export type DiscriminatedUnionOptionType<K extends string> = ObjectType<
  ObjectTypeProps & { [_ in K]: BaseTypeAny }
>

export class DiscriminatedUnionType<
  K extends string = string,
  T extends readonly DiscriminatedUnionOptionType<K>[] =
    DiscriminatedUnionOptionType<K>[],
> extends BaseType<
  ZodMiniDiscriminatedUnion<ArrayMap<T, 'encodeZodType'>>,
  ZodMiniDiscriminatedUnion<ArrayMap<T, 'decodeZodType'>>,
  { key: K; options: T }
> {
  static factory<
    K extends string = string,
    T extends readonly DiscriminatedUnionOptionType<K>[] =
      DiscriminatedUnionOptionType<K>[],
  >(key: K, ...options: T) {
    const encode = options.map((t) => t.encodeZodType) as ArrayMap<
      T,
      'encodeZodType'
    >
    const decode = options.map((t) => t.decodeZodType) as ArrayMap<
      T,
      'decodeZodType'
    >
    return new DiscriminatedUnionType<K, T>({
      // zod demands a concrete `[$ZodTypeDiscriminable<K>, ...]` tuple; the
      // mapped `ArrayMap<T, …>` stays opaque to TS, both as the argument and
      // as the resulting union's option list
      // @ts-expect-error
      encodeZodType: zodDiscriminatedUnion(key, encode),
      // @ts-expect-error
      decodeZodType: zodDiscriminatedUnion(key, decode),
      props: { key, options },
    })
  }
}

export const union = UnionType.factory
export const or = UnionType.factory
export const intersection = IntersectionType.factory
export const and = IntersectionType.factory
export const discriminatedUnion = DiscriminatedUnionType.factory
