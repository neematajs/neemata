import {
  type TIntersect,
  type TObject,
  type TSchema,
  type TUnion,
  Type,
  type UnionToTuple,
} from '@sinclair/typebox'
import type { StaticInputDecode } from '../inference.ts'
import {
  DiscriminatedUnion,
  type DiscriminatedUnionProperties,
  type TDiscriminatedUnion,
} from '../schemas/discriminated-union.ts'
import { BaseType, type BaseTypeAny } from './base.ts'
import type { ObjectType, ObjectTypeProps } from './object.ts'

export class UnionType<
  T extends readonly BaseType[] = readonly BaseType[],
  S extends TSchema[] = UnionToTuple<T[number]['schema']>,
> extends BaseType<TUnion<S>, { options: T }, StaticInputDecode<TUnion<S>>> {
  static factory<
    T extends readonly BaseType[] = readonly BaseType[],
    S extends TSchema[] = UnionToTuple<T[number]['schema']>,
  >(...options: T) {
    return new UnionType<T, S>(
      Type.Union(options.map((t) => t.schema)) as any,
      {
        options,
      },
    )
  }
}

export class IntersactionType<
  T extends readonly BaseType[] = readonly BaseType[],
  S extends TSchema[] = UnionToTuple<T[number]['schema']>,
> extends BaseType<
  TIntersect<S>,
  { options: T },
  StaticInputDecode<TIntersect<S>>
> {
  static factory<
    T extends readonly BaseType[] = readonly BaseType[],
    S extends TSchema[] = UnionToTuple<T[number]['schema']>,
  >(...options: T) {
    return new IntersactionType<T, S>(
      Type.Intersect(options.map((t) => t.schema)) as any,
      { options },
    )
  }
}

export type DiscriminatedUnionOptionType<K extends string> = ObjectType<
  ObjectTypeProps & { [_ in K]: BaseTypeAny }
>

export class DiscriminatedUnionType<
  K extends string = string,
  T extends
    readonly DiscriminatedUnionOptionType<K>[] = DiscriminatedUnionOptionType<K>[],
  S extends TObject<DiscriminatedUnionProperties<K>>[] = [],
> extends BaseType<
  TDiscriminatedUnion<K, S>,
  {
    key: K
    options: T
  },
  StaticInputDecode<TDiscriminatedUnion<K, S>>
> {
  static factory<
    K extends string,
    T extends readonly DiscriminatedUnionOptionType<K>[],
    //@ts-expect-error
    S extends TObject<DiscriminatedUnionProperties<K>>[] = UnionToTuple<
      T[number]['schema']
    >,
  >(key: K, ...options: T) {
    return new DiscriminatedUnionType<K, T, S>(
      DiscriminatedUnion(key, options.map((t) => t.schema) as any),
      { key, options },
    )
  }
}
