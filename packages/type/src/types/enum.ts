import type { TNativeEnum } from '../schemas/native-enum.ts'
import { NativeEnum } from '../schemas/native-enum.ts'
import { type TUnionEnum, UnionEnum } from '../schemas/union-enum.ts'
import { BaseType } from './base.ts'

export class NativeEnumType<
  T extends { [K in string]: K } = { [K in string]: K },
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TNativeEnum<T>, N, O> {
  constructor(
    readonly values: T,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(NativeEnum(values), nullable, optional)
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new NativeEnumType(this.values, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new NativeEnumType(this.values, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new NativeEnumType(this.values, ...args)
  }
}

export class EnumType<
  T extends (string | number)[],
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TUnionEnum<T>, N, O> {
  constructor(
    readonly values: [...T],
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    super(UnionEnum(values), nullable, optional)
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new EnumType(this.values, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new EnumType(this.values, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new EnumType(this.values, ...args)
  }
}
