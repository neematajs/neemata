import type { TLiteralValue } from '@sinclair/typebox'
import { ArrayType } from './types/array.ts'
import type { BaseType } from './types/base.ts'
import { BooleanType } from './types/boolean.ts'
import { CustomType } from './types/custom.ts'
import { DateType } from './types/datetime.ts'
import { EnumType, NativeEnumType } from './types/enum.ts'
import { LiteralType } from './types/literal.ts'
import { IntegerType, NumberType } from './types/number.ts'
import { ObjectType } from './types/object.ts'
import { StringType } from './types/string.ts'
import { IntersactionType, UnionType } from './types/union.ts'

import type { typeStatic } from './constants.ts'
// register ajv formats
import { register } from './formats.ts'
import { AnyType } from './types/any.ts'
import { NeverType } from './types/never.ts'
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
    export type decoded<T extends BaseType> = T[typeStatic]['decoded']
    export type encoded<T extends BaseType> = T[typeStatic]['encoded']
  }
  export const never = () => new NeverType()
  export const boolean = () => new BooleanType()
  export const string = () => new StringType()
  export const number = () => new NumberType()
  export const integer = () => new IntegerType()
  export const literal = <T extends TLiteralValue>(value: T) =>
    new LiteralType(value)
  export const nativeEnum = <T extends { [K in string]: K }>(enumLike: T) =>
    new NativeEnumType(enumLike)
  export const arrayEnum = <T extends (string | number)[]>(enumLike: [...T]) =>
    new EnumType(enumLike)
  export const date = () => new DateType()
  export const array = <T extends BaseType>(element: T) =>
    new ArrayType(element)
  export const object = <T extends Record<string, BaseType>>(properties: T) =>
    new ObjectType(properties)
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
