import {
  type ObjectOptions,
  type TObject,
  type TRecord,
  Type,
} from '@sinclair/typebox'
import type { typeStatic } from '../constants.ts'
import type { UnionToTupleString } from '../utils.ts'
import { BaseType, getTypeSchema } from './base.ts'
import { type AnyEnumType, type AnyNativeEnumType, EnumType } from './enum.ts'
import type { AnyLiteralType } from './literal.ts'
import type { AnyStringType } from './string.ts'
import type { AnyUnionType } from './union.ts'

export class ObjectType<
  T extends Record<string, BaseType>,
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TObject<{ [K in keyof T]: T[K][typeStatic]['schema'] }>,
  N,
  O,
  D
> {
  constructor(
    protected readonly properties: T = {} as T,
    options: ObjectOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, properties)
  }

  protected _constructSchema(
    options: ObjectOptions,
    properties: T,
  ): TObject<{ [K in keyof T]: T[K][typeStatic]['schema'] }> {
    const schemaProperties = {} as {
      [K in keyof T]: T[K][typeStatic]['schema']
    }

    for (const [key, value] of Object.entries(properties)) {
      // @ts-expect-error
      schemaProperties[key] = getTypeSchema(value)
    }
    return Type.Object(schemaProperties, options)
  }

  nullable() {
    return new ObjectType(this.properties, ...this._with({ isNullable: true }))
  }

  optional() {
    return new ObjectType(this.properties, ...this._with({ isOptional: true }))
  }

  nullish() {
    return new ObjectType(
      this.properties,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: this[typeStatic]['encoded']) {
    return new ObjectType(
      this.properties,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new ObjectType(
      this.properties,
      ...this._with({ options: { description } }),
    )
  }

  examples(
    ...examples: [this[typeStatic]['encoded'], ...this[typeStatic]['encoded'][]]
  ) {
    return new ObjectType(
      this.properties,
      ...this._with({ options: { examples } }),
    )
  }

  pick<P extends { [K in keyof T]?: true }>(pick: P) {
    const properties = Object.fromEntries(
      Object.entries(this.properties).filter(([key]) => pick[key]),
    )
    const [_, ...args] = this._with()
    return new ObjectType(
      properties as Pick<T, Extract<keyof P, keyof T>>,
      {},
      ...args,
    )
  }

  omit<P extends { [K in keyof T]?: true }>(omit: P) {
    const properties = Object.fromEntries(
      Object.entries(this.properties).filter(([key]) => !omit[key]),
    )
    const [_, ...args] = this._with()
    return new ObjectType(
      properties as Omit<T, Extract<keyof P, keyof T>>,
      {},
      ...args,
    )
  }

  extend<P extends Record<string, BaseType>>(properties: P) {
    const [_, ...args] = this._with()
    return new ObjectType({ ...this.properties, ...properties }, {}, ...args)
  }

  merge<T extends ObjectType<Record<string, BaseType>>>(object: T) {
    const [_, ...args] = this._with()
    return new ObjectType(
      { ...this.properties, ...object.properties },
      {},
      ...args,
    )
  }

  partial() {
    const properties: { [K in keyof T]: ReturnType<T[K]['optional']> } =
      {} as any
    for (const [key, value] of Object.entries(this.properties)) {
      // @ts-expect-error
      properties[key] = value.optional()
    }
    const [_, ...args] = this._with()
    return new ObjectType(properties, {}, ...args)
  }

  keyof(): EnumType<UnionToTupleString<keyof T>> {
    return new EnumType(Object.keys(this.properties) as any)
  }
}

export class RecordType<
  K extends
    | AnyLiteralType
    | AnyEnumType
    | AnyNativeEnumType
    | AnyStringType
    | AnyUnionType,
  E extends BaseType,
  N extends boolean = false,
  O extends boolean = false,
  D extends boolean = false,
> extends BaseType<
  TRecord<K[typeStatic]['schema'], E[typeStatic]['schema']>,
  N,
  O,
  D,
  ObjectOptions
> {
  constructor(
    protected readonly key: K,
    protected readonly element: E,
    options: ObjectOptions = {},
    isNullable: N = false as N,
    isOptional: O = false as O,
    hasDefault: D = false as D,
  ) {
    super(options, isNullable, isOptional, hasDefault, key, element)
  }

  protected _constructSchema(options: ObjectOptions, key: K, element: E) {
    return Type.Record(
      getTypeSchema(key),
      getTypeSchema(element),
      options,
    ) as TRecord<K[typeStatic]['schema'], E[typeStatic]['schema']>
  }

  nullable() {
    return new RecordType(
      this.key,
      this.element,
      ...this._with({ isNullable: true }),
    )
  }

  optional() {
    return new RecordType(
      this.key,
      this.element,
      ...this._with({ isOptional: true }),
    )
  }

  nullish() {
    return new RecordType(
      this.key,
      this.element,
      ...this._with({ isNullable: true, isOptional: true }),
    )
  }

  default(value: this[typeStatic]['encoded']) {
    return new RecordType(
      this.key,
      this.element,
      ...this._with({ options: { default: value }, hasDefault: true }),
    )
  }

  description(description: string) {
    return new RecordType(
      this.key,
      this.element,
      ...this._with({ options: { description } }),
    )
  }

  examples(
    ...examples: [this[typeStatic]['encoded'], ...this[typeStatic]['encoded'][]]
  ) {
    return new RecordType(
      this.key,
      this.element,
      ...this._with({ options: { examples } }),
    )
  }
}
