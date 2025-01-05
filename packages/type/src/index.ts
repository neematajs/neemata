import type {
  StaticDecode,
  StaticEncode,
  TLiteralValue,
} from '@sinclair/typebox/type'
import { AnyType } from './types/any.ts'
import { ArrayType } from './types/array.ts'
import type {
  BaseType,
  BaseTypeAny,
  OptionalType,
  Static,
} from './types/base.ts'
import { BooleanType } from './types/boolean.ts'
import { CustomType } from './types/custom.ts'
import { DateType } from './types/date.ts'
import { EnumType, ObjectEnumType } from './types/enum.ts'
import { LiteralType } from './types/literal.ts'
import { NeverType } from './types/never.ts'
import { BigIntType, IntegerType, NumberType } from './types/number.ts'
import { ObjectType, type ObjectTypeProps, RecordType } from './types/object.ts'
import { StringType } from './types/string.ts'
import {
  DiscriminatedUnionType,
  IntersactionType,
  UnionType,
} from './types/union.ts'
import type { UnionToTupleString } from './utils.ts'

// register ajv formats
import { register } from './formats.ts'
register()

export * from './schemas/nullable.ts'
export { BaseType, type BaseTypeAny } from './types/base.ts'
export { type TSchema } from '@sinclair/typebox'
export {
  ArrayType,
  BooleanType,
  CustomType,
  DateType,
  EnumType,
  LiteralType,
  IntegerType,
  NumberType,
  ObjectType,
  StringType,
  IntersactionType,
  UnionType,
  AnyType,
  NeverType,
}

export namespace t {
  export namespace infer {
    export type decoded<T extends BaseTypeAny> = StaticDecode<
      T['_']['decoded']['output']
    >
    export type encoded<T extends BaseTypeAny> = StaticEncode<
      T['_']['encoded']['output']
    >
    export namespace input {
      export type decoded<T extends BaseTypeAny> = StaticDecode<
        T['_']['decoded']['input']
      >
      export type encoded<T extends BaseTypeAny> = StaticEncode<
        T['_']['encoded']['input']
      >
    }
  }

  export const never = NeverType.factory
  export const boolean = BooleanType.factory
  export const string = StringType.factory
  export const number = NumberType.factory
  export const integer = IntegerType.factory
  export const bitint = BigIntType.factory
  export const literal = LiteralType.factory
  export const objectEnum = ObjectEnumType.factory
  export const arrayEnum = EnumType.factory
  export const date = DateType.factory
  export const array = ArrayType.factory
  export const object = ObjectType.factory
  export const record = RecordType.factory
  export const any = AnyType.factory
  export const or = UnionType.factory
  export const and = IntersactionType.factory
  export const discriminatedUnion = DiscriminatedUnionType.factory
  export const custom = CustomType.factory

  export const keyof = <T extends ObjectType>(
    type: T,
  ): EnumType<
    UnionToTupleString<T extends ObjectType<infer Props> ? keyof Props : never>
  > => {
    return arrayEnum(Object.keys(type.props.properties) as any)
  }

  export const pick = <
    T extends ObjectType,
    P extends { [K in keyof T['props']['properties']]?: true },
  >(
    source: T,
    pick: P,
  ): ObjectType<{
    [K in keyof T['props']['properties'] as K extends keyof P
      ? K
      : never]: T['props']['properties'][K]
  }> => {
    const properties = Object.fromEntries(
      Object.entries(source.props.properties).filter(([key]) => pick[key]),
    )
    return ObjectType.factory(properties) as any
  }

  export const omit = <
    T extends ObjectType,
    P extends { [K in keyof T]?: true },
  >(
    source: T,
    omit: P,
  ): ObjectType<{
    [K in keyof T['props']['properties'] as K extends keyof P
      ? never
      : K]: T['props']['properties'][K]
  }> => {
    const properties = Object.fromEntries(
      Object.entries(source.props.properties).filter(([key]) => !omit[key]),
    )
    return ObjectType.factory(properties) as any
  }

  export const extend = <T extends ObjectType, P extends ObjectTypeProps>(
    object1: T,
    properties: P,
  ): ObjectType<{
    [K in keyof T['props']['properties'] | keyof P]: K extends keyof P
      ? P[K]
      : K extends keyof T['props']['properties']
        ? T['props']['properties'][K]
        : never
  }> => {
    return ObjectType.factory({
      ...object1.props.properties,
      ...properties,
    }) as any
  }

  export const merge = <T1 extends ObjectType, T2 extends ObjectType>(
    object1: T1,
    object2: T2,
  ): ObjectType<{
    [K in
      | keyof T1['props']['properties']
      | keyof T2['props']['properties']]: K extends keyof T2['props']['properties']
      ? T2['props']['properties'][K]
      : K extends keyof T1['props']['properties']
        ? T1['props']['properties'][K]
        : never
  }> => {
    return ObjectType.factory({
      ...object1.props.properties,
      ...object2.props.properties,
    }) as any
  }

  export const partial = <T extends ObjectType>(
    object: T,
  ): ObjectType<{
    [K in keyof T['props']['properties']]: OptionalType<
      T['props']['properties'][K]
    >
  }> => {
    const properties = {} as any

    for (const [key, value] of Object.entries(object.props.properties)) {
      properties[key] = value.optional()
    }

    return ObjectType.factory(properties, {}) as any
  }
}
