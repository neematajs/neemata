import type {
  StaticInputDecode,
  StaticInputEncode,
  StaticOutputDecode,
  StaticOutputEncode,
} from './inference.ts'
import { AnyType } from './types/any.ts'
import { ArrayType } from './types/array.ts'
import type { BaseTypeAny, OptionalType } from './types/base.ts'
import { BooleanType } from './types/boolean.ts'
import { CustomType } from './types/custom.ts'
import { DateType } from './types/date.ts'
import { EnumType, ObjectEnumType } from './types/enum.ts'
import { LiteralType } from './types/literal.ts'
import { NeverType } from './types/never.ts'
import { BigIntType, IntegerType, NumberType } from './types/number.ts'
import {
  ObjectType,
  RecordType,
  extend,
  keyof,
  merge,
  omit,
  partial,
  pick,
} from './types/object.ts'
import { StringType } from './types/string.ts'
import {
  DiscriminatedUnionType,
  IntersactionType,
  UnionType,
} from './types/union.ts'
import type { UnionToTupleString } from './utils.ts'

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
    export type decoded<T extends BaseTypeAny<any>> = StaticOutputDecode<
      T['schema']
    >
    export type encoded<T extends BaseTypeAny<any>> = StaticOutputEncode<
      T['schema']
    >
    export namespace input {
      export type decoded<T extends BaseTypeAny<any>> = StaticInputDecode<
        T['schema']
      >
      export type encoded<T extends BaseTypeAny<any>> = StaticInputEncode<
        T['schema']
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
  export const record = RecordType.factory
  export const any = AnyType.factory
  export const or = UnionType.factory
  export const and = IntersactionType.factory
  export const discriminatedUnion = DiscriminatedUnionType.factory
  export const custom = CustomType.factory
  export const object = Object.assign(ObjectType.factory.bind(ObjectType), {
    keyof,
    partial,
    merge,
    omit,
    extend,
    pick,
  })
}
