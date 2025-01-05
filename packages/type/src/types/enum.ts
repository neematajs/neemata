import {
  Enum,
  type SchemaOptions,
  type StaticDecode,
  type TEnum,
  Type,
} from '@sinclair/typebox'
import { BaseType, type ConstantType } from './base.ts'

export class ObjectEnumType<
  T extends { [K in string]: K } = { [K in string]: K },
> extends BaseType<TEnum<T>> {
  declare _: ConstantType<this['schema']>

  static factory<T extends { [K in string]: K }>(values: T) {
    return new ObjectEnumType<T>(Type.Enum(values as any))
  }
}

export class EnumType<
  T extends (string | number)[] = (string | number)[],
> extends BaseType<TEnum<Record<string, T[number]>>> {
  declare _: ConstantType<this['schema']>

  static factory<T extends (string | number)[]>(values: [...T]) {
    return new EnumType<T>(
      Type.Enum(Object.fromEntries(values.map((v) => [v, v])) as any),
    )
  }
}
