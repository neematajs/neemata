import {
  type core,
  discriminatedUnion,
  intersection,
  union,
  type ZodMiniDiscriminatedUnion,
  type ZodMiniIntersection,
  type ZodMiniUnion,
} from '@zod/mini'
import { BaseType, type BaseTypeAny } from './base.ts'
import type { LiteralType } from './literal.ts'
import type { ObjectType, ObjectTypeProps } from './object.ts'

export class UnionType<
  T extends readonly BaseType[] = readonly BaseType[],
> extends BaseType<
  ZodMiniUnion<core.utils.Flatten<T[number]['encodedZodType'][]>>,
  ZodMiniUnion<core.utils.Flatten<T[number]['decodedZodType'][]>>,
  { options: T }
> {
  static factory<T extends readonly BaseType[] = readonly BaseType[]>(
    ...options: T
  ) {
    return new UnionType<T>({
      encodedZodType: union(options.map((t) => t.encodedZodType)),
      decodedZodType: union(options.map((t) => t.decodedZodType)),
      props: { options },
    })
  }
}

export class IntersactionType<
  T extends readonly [BaseType, BaseType] = readonly [BaseType, BaseType],
> extends BaseType<
  ZodMiniIntersection<T[0]['encodedZodType'], T[1]['encodedZodType']>,
  ZodMiniIntersection<T[0]['decodedZodType'], T[1]['decodedZodType']>,
  { options: T }
> {
  static factory<
    T extends readonly [BaseType, BaseType] = readonly [BaseType, BaseType],
  >(...options: T) {
    const [first, second] = options
    return new IntersactionType<T>({
      encodedZodType: intersection(first.encodedZodType, second.encodedZodType),
      decodedZodType: intersection(first.decodedZodType, second.decodedZodType),
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
  ZodMiniDiscriminatedUnion<core.utils.Flatten<T[number]['encodedZodType'][]>>,
  ZodMiniDiscriminatedUnion<core.utils.Flatten<T[number]['decodedZodType'][]>>,
  {
    key: K
    options: T
  }
> {
  static factory<
    K extends string = string,
    T extends
      readonly DiscriminatedUnionOptionType<K>[] = DiscriminatedUnionOptionType<K>[],
  >(key: K, ...options: T) {
    return new DiscriminatedUnionType<K, T>({
      encodedZodType: discriminatedUnion(
        options.map((t) => t.encodedZodType) as any,
      ),
      decodedZodType: discriminatedUnion(
        options.map((t) => t.decodedZodType) as any,
      ),
      props: { key, options },
    })
  }
}
