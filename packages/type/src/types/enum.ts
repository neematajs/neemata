import * as zod from 'zod/v4-mini'
import { BaseType } from './base.ts'

export class EnumType<
  T extends zod.core.util.EnumLike = zod.core.util.EnumLike,
> extends BaseType<zod.ZodMiniEnum<T>, zod.ZodMiniEnum<T>, { values: T }> {
  static factory<T extends zod.core.util.EnumLike>(values: T): EnumType<T>
  static factory<T extends string[]>(
    values: T,
  ): EnumType<zod.core.util.ToEnum<T[number]>>
  static factory<T extends zod.core.util.EnumLike | string[]>(values: T) {
    return new EnumType({
      encodedZodType: zod.enum(values as any),
      props: { values },
    })
  }
}

const _enum = EnumType.factory

export { _enum as enum }
