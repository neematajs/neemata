import { type core, enum as enum_, type ZodMiniEnum } from '@zod/mini'
import { BaseType } from './base.ts'

export class EnumType<
  T extends core.util.EnumLike = core.util.EnumLike,
> extends BaseType<ZodMiniEnum<T>, ZodMiniEnum<T>, { values: T }> {
  static factory<T extends core.util.EnumLike>(values: T): EnumType<T>
  static factory<T extends string[]>(
    values: T,
  ): EnumType<core.util.ToEnum<T[number]>>
  static factory<T extends core.util.EnumLike | string[]>(values: T) {
    return new EnumType({
      encodedZodType: enum_(values as any),
      props: { values },
    })
  }
}
