import * as zod from '@zod/mini'
import { AnyType } from './types/any.ts'
import { ArrayType } from './types/array.ts'
import type { BaseTypeAny } from './types/base.ts'
import { BooleanType } from './types/boolean.ts'
import { CustomType } from './types/custom.ts'
import { DateType } from './types/date.ts'
import { EnumType } from './types/enum.ts'
import { LiteralType } from './types/literal.ts'
import { NeverType } from './types/never.ts'
import { BigIntType, IntegerType, NumberType } from './types/number.ts'
import {
  extend,
  keyof,
  merge,
  ObjectType,
  omit,
  partial,
  pick,
  RecordType,
} from './types/object.ts'
import { StringType } from './types/string.ts'
import {
  DiscriminatedUnionType,
  IntersactionType,
  UnionType,
} from './types/union.ts'

zod.config(zod.core.locales.en())

export { NeemataTypeError } from './types/base.ts'
export { BaseType, type BaseTypeAny } from './types/base.ts'
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
  DiscriminatedUnionType,
  RecordType,
}

export namespace type {
  export namespace infer {
    export type decoded<T extends BaseTypeAny> =
      T['decodedZodType']['_zod']['output']

    export type encoded<T extends BaseTypeAny> =
      T['encodedZodType']['_zod']['output']

    export namespace input {
      export type decoded<T extends BaseTypeAny> =
        T['decodedZodType']['_zod']['input']

      export type encoded<T extends BaseTypeAny> =
        T['encodedZodType']['_zod']['input']
    }
  }

  export const never = NeverType.factory
  export const boolean = BooleanType.factory
  export const string = StringType.factory
  export const number = NumberType.factory
  export const integer = IntegerType.factory
  export const bitint = BigIntType.factory
  export const literal = LiteralType.factory
  export const enumeration = EnumType.factory
  export const date = DateType.factory
  export const array = ArrayType.factory
  export const record = RecordType.factory
  export const any = AnyType.factory
  export const or = UnionType.factory
  export const and = IntersactionType.factory
  export const union = UnionType.factory
  export const intersaction = IntersactionType.factory
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

export { type as t, zod }
