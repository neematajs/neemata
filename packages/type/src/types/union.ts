import { type TIntersect, type TUnion, Type } from '@sinclair/typebox'
import type { UnionToTuple } from '../utils.ts'
import { BaseType, typeFinalSchema } from './base.ts'

export class UnionType<
  T extends [BaseType, BaseType, ...BaseType[]] = [
    BaseType,
    BaseType,
    ...BaseType[],
  ],
  N extends boolean = false,
  O extends boolean = false,
  // @ts-expect-error
> extends BaseType<TUnion<UnionToTuple<T[number][typeFinal]>>, N, O> {
  constructor(
    readonly types: T,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(
      Type.Union(types.map((t) => t[typeFinalSchema])) as any,
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new UnionType(this.types, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new UnionType(this.types, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new UnionType(this.types, ...args)
  }
}

export class IntersactionType<
  T extends [BaseType, BaseType, ...BaseType[]] = [
    BaseType,
    BaseType,
    ...BaseType[],
  ],
  N extends boolean = false,
  O extends boolean = false,
  // @ts-expect-error
> extends BaseType<TIntersect<UnionToTuple<T[number][typeFinal]>>, N, O> {
  constructor(
    readonly types: T,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(
      Type.Intersect(types.map((t) => t[typeFinalSchema])) as any,
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new IntersactionType(this.types, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new IntersactionType(this.types, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new IntersactionType(this.types, ...args)
  }
}
