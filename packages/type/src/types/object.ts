import { type TObject, Type } from '@sinclair/typebox'
import type { UnionToTupleString } from '../utils.ts'
import { BaseType, typeFinalSchema } from './base.ts'
import { EnumType } from './enum.ts'

export class ObjectType<
  T extends Record<string, BaseType> = Record<string, BaseType>,
  N extends boolean = false,
  O extends boolean = false,
> extends BaseType<TObject<{ [K in keyof T]: T[K][typeFinalSchema] }>, N, O> {
  constructor(
    readonly properties: T = {} as T,
    nullable: N = false as N,
    optional: O = false as O,
  ) {
    const schemaProperties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        value[typeFinalSchema],
      ]),
    )
    super(
      Type.Object(
        schemaProperties as { [K in keyof T]: T[K][typeFinalSchema] },
      ),
      nullable,
      optional,
    )
  }

  nullable() {
    const [_, ...args] = this._nullable()
    return new ObjectType(this.properties, ...args)
  }

  optional() {
    const [_, ...args] = this._optional()
    return new ObjectType(this.properties, ...args)
  }

  nullish() {
    const [_, ...args] = this._nullish()
    return new ObjectType(this.properties, ...args)
  }

  pick<P extends { [K in keyof T]?: true }>(pick: P) {
    const properties = Object.fromEntries(
      Object.entries(this.properties).filter(([key]) => pick[key]),
    )
    return new ObjectType(
      properties as Pick<T, Extract<keyof P, keyof T>>,
      ...this._isNullableOptional,
    )
  }

  omit<P extends { [K in keyof T]?: true }>(omit: P) {
    const properties = Object.fromEntries(
      Object.entries(this.properties).filter(([key]) => !omit[key]),
    )
    return new ObjectType(
      properties as Omit<T, Extract<keyof P, keyof T>>,
      ...this._isNullableOptional,
    )
  }

  extend<P extends Record<string, BaseType>>(properties: P) {
    return new ObjectType(
      { ...this.properties, ...properties },
      ...this._isNullableOptional,
    )
  }

  merge<T extends ObjectType>(object: T) {
    return new ObjectType(
      { ...this.properties, ...object.properties },
      ...this._isNullableOptional,
    )
  }

  keyof(): EnumType<UnionToTupleString<keyof T>> {
    return new EnumType(Object.keys(this.properties) as any)
  }
}
