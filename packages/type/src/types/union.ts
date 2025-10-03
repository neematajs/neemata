import type { ArrayMap } from '@nmtjs/common'
import * as zod from 'zod/mini'

import type { BaseTypeAny } from './base.ts'
import type { LiteralType } from './literal.ts'
import type { ObjectType, ObjectTypeProps } from './object.ts'
import { BaseType } from './base.ts'

export class UnionType<
  T extends readonly [BaseType, ...BaseType[]] = readonly [
    BaseType,
    ...BaseType[],
  ],
> extends BaseType<
  zod.ZodMiniUnion<ArrayMap<T, 'encodedZodType'>>,
  zod.ZodMiniUnion<ArrayMap<T, 'decodedZodType'>>,
  { options: T }
> {
  static factory<
    T extends readonly [BaseType, ...BaseType[]] = readonly [
      BaseType,
      ...BaseType[],
    ],
  >(...options: T) {
    const encoded = options.map((t) => t.encodedZodType) as ArrayMap<
      T,
      'encodedZodType'
    >
    const decoded = options.map((t) => t.decodedZodType) as ArrayMap<
      T,
      'decodedZodType'
    >
    return new UnionType<T>({
      encodedZodType: zod.union(encoded),
      decodedZodType: zod.union(decoded),
      props: { options },
    })
  }
}

export class IntersactionType<
  T extends readonly [BaseType, BaseType] = readonly [BaseType, BaseType],
> extends BaseType<
  zod.ZodMiniIntersection<T[0]['encodedZodType'], T[1]['encodedZodType']>,
  zod.ZodMiniIntersection<T[0]['decodedZodType'], T[1]['decodedZodType']>,
  { options: T }
> {
  static factory<
    T extends readonly [BaseType, BaseType] = readonly [BaseType, BaseType],
  >(...options: T) {
    const [first, second] = options
    return new IntersactionType<T>({
      encodedZodType: zod.intersection(
        first.encodedZodType,
        second.encodedZodType,
      ),
      decodedZodType: zod.intersection(
        first.decodedZodType,
        second.decodedZodType,
      ),
      props: { options },
    })
  }
}

export type DiscriminatedUnionProperties<K extends string = string> = {
  [OK in K]: LiteralType<string>
} & {
  [OK in string]: any
}

export type DiscriminatedUnionOptionType<K extends string> = ObjectType<
  ObjectTypeProps & { [_ in K]: BaseTypeAny }
>

export class DiscriminatedUnionType<
  K extends string = string,
  T extends
    readonly DiscriminatedUnionOptionType<K>[] = DiscriminatedUnionOptionType<K>[],
> extends BaseType<
  zod.ZodMiniDiscriminatedUnion<ArrayMap<T, 'encodedZodType'>>,
  zod.ZodMiniDiscriminatedUnion<ArrayMap<T, 'decodedZodType'>>,
  { key: K; options: T }
> {
  static factory<
    K extends string = string,
    T extends
      readonly DiscriminatedUnionOptionType<K>[] = DiscriminatedUnionOptionType<K>[],
  >(key: K, ...options: T) {
    const encoded = options.map((t) => t.encodedZodType) as ArrayMap<
      T,
      'encodedZodType'
    >
    const decoded = options.map((t) => t.decodedZodType) as ArrayMap<
      T,
      'decodedZodType'
    >
    return new DiscriminatedUnionType<K, T>({
      // @ts-expect-error
      encodedZodType: zod.discriminatedUnion(key, encoded),
      // @ts-expect-error
      decodedZodType: zod.discriminatedUnion(key, decoded),
      props: { key, options },
    })
  }
}

export const union = UnionType.factory
export const or = UnionType.factory
export const intersection = IntersactionType.factory
export const and = IntersactionType.factory
export const discriminatedUnion = DiscriminatedUnionType.factory
