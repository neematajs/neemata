import { type TEnum, Type } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export class ObjectEnumType<
  T extends { [K in string]: K } = { [K in string]: K },
> extends BaseType<TEnum<T>, { values: T[keyof T] }, T[keyof T]> {
  static factory<T extends { [K in string]: K }>(values: T) {
    return new ObjectEnumType<T>(Type.Enum(values as any), {
      values: Object.values(values) as unknown as T[keyof T],
    })
  }
}

export class EnumType<
  T extends (string | number)[] = (string | number)[],
> extends BaseType<
  TEnum<Record<string, T[number]>>,
  { values: [...T] },
  T[keyof T]
> {
  static factory<T extends (string | number)[]>(values: [...T]) {
    return new EnumType<T>(
      Type.Enum(Object.fromEntries(values.map((v) => [v, v])) as any),
      { values },
    )
  }
}
