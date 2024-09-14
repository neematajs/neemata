import {
  type SchemaOptions,
  type TIntersect,
  type TUnion,
  Type,
} from '@sinclair/typebox'
import type { typeStatic } from '../constants.ts'
import type { UnionToTuple } from '../utils.ts'
import { BaseType, getTypeSchema } from './base.ts'

export type AnyUnionType<
  T extends [BaseType, BaseType, ...BaseType[]] = [
    BaseType,
    BaseType,
    ...BaseType[],
  ],
> = UnionType<T, boolean, boolean, boolean>
export class UnionType<
  T extends [BaseType, BaseType, ...BaseType[]] = [
    BaseType,
    BaseType,
    ...BaseType[],
  ],
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  //@ts-expect-error
  TUnion<UnionToTuple<T[number][typeStatic]['schema']>>,
  N,
  O,
  D
> {
  constructor(
    readonly types: T,
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
    //@ts-expect-error
  ): TUnion<UnionToTuple<T[number][typeStatic]['schema']>> {
    return Type.Union(this.types.map(getTypeSchema), options) as any
  }

  nullable() {
    return new UnionType(this.types, ...this._with({ isNullable: true }))
  }

  optional() {
    return new UnionType(this.types, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new UnionType(
      this.types,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: this[typeStatic]['encoded']) {
    return new UnionType(
      this.types,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new UnionType(
      this.types,
      ...this._with({ options: { description } }),
    )
  }

  examples(
    ...examples: [this[typeStatic]['encoded'], ...this[typeStatic]['encoded'][]]
  ) {
    return new UnionType(this.types, ...this._with({ options: { examples } }))
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
  D extends boolean = false,
> extends BaseType<
  // @ts-expect-error
  TIntersect<UnionToTuple<T[number][typeStatic]['schema']>>,
  N,
  O,
  D
> {
  constructor(
    readonly types: T,
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault)
  }

  protected _constructSchema(
    options: SchemaOptions,
    // @ts-expect-error
  ): TIntersect<UnionToTuple<T[number][typeStatic]['schema']>> {
    return Type.Intersect(this.types.map(getTypeSchema), options) as any
  }

  nullable() {
    return new IntersactionType(this.types, ...this._with({ isNullable: true }))
  }

  optional() {
    return new IntersactionType(this.types, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new IntersactionType(
      this.types,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: this[typeStatic]['encoded']) {
    return new IntersactionType(
      this.types,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new IntersactionType(
      this.types,
      ...this._with({ options: { description } }),
    )
  }

  examples(
    ...values: [this[typeStatic]['encoded'], ...this[typeStatic]['encoded'][]]
  ) {
    return new IntersactionType(
      this.types,
      ...this._with({ options: { examples: values } }),
    )
  }
}
