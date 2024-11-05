import { Enum, type SchemaOptions, type TEnum } from '@sinclair/typebox'
import { BaseType } from './base.ts'

export type AnyObjectEnumType<T extends { [K in string]: K } = any> =
  ObjectEnumType<T, boolean, boolean, boolean>
export class ObjectEnumType<
  T extends { [K in string]: K },
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TEnum<T>, N, O, D> {
  constructor(
    private readonly values: T,
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, values)
  }

  protected _constructSchema(options: SchemaOptions, values: T): TEnum<T> {
    return Enum(values, options)
  }

  nullable() {
    return new ObjectEnumType(this.values, ...this._with({ isNullable: true }))
  }

  optional() {
    return new ObjectEnumType(this.values, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new ObjectEnumType(
      this.values,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: keyof T) {
    return new ObjectEnumType(
      this.values,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new ObjectEnumType(
      this.values,
      ...this._with({ options: { description } }),
    )
  }

  examples(...examples: (keyof T)[]) {
    return new ObjectEnumType(
      this.values,
      ...this._with({ options: { examples } }),
    )
  }
}

export type AnyEnumType = EnumType<any, boolean, boolean, boolean>
export class EnumType<
  T extends (string | number)[] = (string | number)[],
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<TEnum<Record<string, T[number]>>, N, O, D> {
  constructor(
    private readonly values: [...T],
    options: SchemaOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, values)
  }

  protected _constructSchema(
    options: SchemaOptions,
    values: [...T],
  ): TEnum<Record<string, T[number]>> {
    return Enum(Object.fromEntries(values.map((k) => [k, k])), options)
  }

  nullable() {
    return new EnumType(this.values, ...this._with({ isNullable: true }))
  }

  optional() {
    return new EnumType(this.values, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new EnumType(
      this.values,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: T[number]) {
    return new EnumType(
      this.values,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new EnumType(
      this.values,
      ...this._with({ options: { description } }),
    )
  }

  examples(...examples: [T[number], ...T[number][]]) {
    return new EnumType(this.values, ...this._with({ options: { examples } }))
  }
}
