import { type core, enum as enum_, type ZodMiniEnum } from '@zod/mini'
import { BaseType } from './base.ts'

export class EnumType<
  T extends core.utils.EnumLike = core.utils.EnumLike,
> extends BaseType<ZodMiniEnum<T>, ZodMiniEnum<T>, { values: T }> {
  static factory<T extends core.utils.EnumLike>(values: T): EnumType<T>
  static factory<T extends string[]>(
    values: T,
  ): EnumType<core.utils.ToEnum<T[number]>>
  static factory<T extends core.utils.EnumLike | string[]>(values: T) {
    return new EnumType({
      encodedZodType: enum_(values as any),
      props: { values },
    })
  }
}
