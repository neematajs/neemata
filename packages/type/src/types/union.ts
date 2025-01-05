import {
  type TIntersect,
  type TUnion,
  Type,
  type UnionToTuple,
} from '@sinclair/typebox'
import {
  DiscriminatedUnion,
  type TDiscriminatedUnion,
} from '../schemas/discriminated-union.ts'
import { BaseType, type BaseTypeAny } from './base.ts'
import type { LiteralType } from './literal.ts'
import type { ObjectType, ObjectTypeProps } from './object.ts'

export class UnionType<
  T extends readonly BaseType[] = readonly BaseType[],
> extends BaseType<TUnion<UnionToTuple<T[number]['schema']>>> {
  _!: {
    encoded: {
      input: TUnion<UnionToTuple<T[number]['_']['encoded']['input']>>
      output: TUnion<UnionToTuple<T[number]['_']['encoded']['output']>>
    }
    decoded: {
      input: TUnion<UnionToTuple<T[number]['_']['decoded']['input']>>
      output: TUnion<UnionToTuple<T[number]['_']['decoded']['output']>>
    }
  }

  static factory<T extends readonly BaseType[] = readonly BaseType[]>(
    ...types: T
  ) {
    return new UnionType<T>(Type.Union(types.map((t) => t.schema)) as any)
  }
}

export class IntersactionType<
  T extends readonly BaseType[] = readonly BaseType[],
> extends BaseType<TIntersect<UnionToTuple<T[number]['schema']>>> {
  _!: {
    encoded: {
      input: TIntersect<UnionToTuple<T[number]['_']['encoded']['input']>>
      output: TIntersect<UnionToTuple<T[number]['_']['encoded']['output']>>
    }
    decoded: {
      input: TIntersect<UnionToTuple<T[number]['_']['decoded']['input']>>
      output: TIntersect<UnionToTuple<T[number]['_']['decoded']['output']>>
    }
  }

  static factory<T extends readonly BaseType[] = readonly BaseType[]>(
    ...types: T
  ) {
    return new IntersactionType<T>(
      Type.Intersect(types.map((t) => t.schema)) as any,
    )
  }
}
