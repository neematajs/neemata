import type { TLiteralValue } from '@sinclair/typebox'
import { ArrayType } from './types/array.ts'
import type { BaseType } from './types/base.ts'
import { BooleanType } from './types/boolean.ts'
import { CustomType } from './types/custom.ts'
import { DateType } from './types/datetime.ts'
import {
  type AnyEnumType,
  type AnyObjectEnumType,
  EnumType,
  ObjectEnumType,
} from './types/enum.ts'
import { type AnyLiteralType, LiteralType } from './types/literal.ts'
import { BigIntType, IntegerType, NumberType } from './types/number.ts'
import { ObjectType, RecordType } from './types/object.ts'
import { type AnyStringType, StringType } from './types/string.ts'
import {
  type AnyUnionType,
  IntersactionType,
  UnionType,
} from './types/union.ts'

import type { typeStatic } from './constants.ts'
import { AnyType } from './types/any.ts'
import { NeverType } from './types/never.ts'

// register ajv formats
import { register } from './formats.ts'
register()

export * from './schemas/native-enum.ts'
export * from './schemas/union-enum.ts'
export * from './schemas/nullable.ts'
export {
  BaseType,
  getTypeSchema,
} from './types/base.ts'
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
    export type staticType<T extends BaseType> = T[typeStatic]
    export type decoded<T extends BaseType> = staticType<T>['decoded']
    export type encoded<T extends BaseType> = staticType<T>['encoded']
  }
  export const never = () => new NeverType()
  export const boolean = () => new BooleanType()
  export const string = () => new StringType()
  export const number = () => new NumberType()
  export const integer = () => new IntegerType()
  export const bitint = () => new BigIntType()
  export const literal = <T extends TLiteralValue>(value: T) =>
    new LiteralType(value)
  export const objectEnum = <T extends { [K in string]: K }>(enumLike: T) =>
    new ObjectEnumType(enumLike)
  export const arrayEnum = <T extends (string | number)[]>(enumLike: [...T]) =>
    new EnumType(enumLike)
  export const date = () => new DateType()
  export const array = <T extends BaseType>(element: T) =>
    new ArrayType(element)
  export const object = <T extends Record<string, BaseType>>(properties: T) =>
    new ObjectType(properties)
  export const record = <
    K extends
      | AnyLiteralType
      | AnyEnumType
      | AnyObjectEnumType
      | AnyStringType
      | AnyUnionType,
    E extends BaseType,
  >(
    key: K,
    value: E,
  ) => new RecordType(key, value)
  export const any = () => new AnyType()
  export const or = <T extends [BaseType, BaseType, ...BaseType[]]>(
    ...types: T
  ) => new UnionType(types)
  export const and = <T extends [BaseType, BaseType, ...BaseType[]]>(
    ...types: T
  ) => new IntersactionType(types)
  export const custom = <T>(
    decode: (value: any) => T,
    encode: (value: T) => any,
  ) => new CustomType<T>(decode, encode)
}
