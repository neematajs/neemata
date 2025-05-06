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
import { TupleType } from './types/tuple.ts'
import {
  DiscriminatedUnionType,
  IntersactionType,
  UnionType,
} from './types/union.ts'

zod.config(zod.core.locales.en())

export { NeemataTypeError } from './types/base.ts'
export { BaseType, type BaseTypeAny } from './types/base.ts'
export {
  AnyType,
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
  TupleType,
  NeverType,
  DiscriminatedUnionType,
  RecordType,
}

export namespace type {
  export namespace infer {
    export namespace decoded {
      export type input<T extends BaseTypeAny> =
        T['decodedZodType']['_zod']['input']
      export type output<T extends BaseTypeAny> =
        T['decodedZodType']['_zod']['output']
    }

    export namespace encoded {
      export type input<T extends BaseTypeAny> =
        T['encodedZodType']['_zod']['input']
      export type output<T extends BaseTypeAny> =
        T['encodedZodType']['_zod']['output']
    }
  }
}

export const type = {
  never: NeverType.factory,
  boolean: BooleanType.factory,
  string: StringType.factory,
  number: NumberType.factory,
  integer: IntegerType.factory,
  bigint: BigIntType.factory,
  literal: LiteralType.factory,
  enum: EnumType.factory,
  tuple: TupleType.factory,
  date: DateType.factory,
  array: ArrayType.factory,
  record: RecordType.factory,
  any: AnyType.factory,
  or: UnionType.factory,
  and: IntersactionType.factory,
  union: UnionType.factory,
  intersaction: IntersactionType.factory,
  discriminatedUnion: DiscriminatedUnionType.factory,
  custom: CustomType.factory,
  object: ObjectType.factory,
  keyof,
  partial,
  merge,
  omit,
  extend,
  pick,
}
export { type as t, zod }
export default type
