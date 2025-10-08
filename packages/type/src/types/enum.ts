import type { core, ZodMiniEnum } from 'zod/mini'
import { enum as zodEnum } from 'zod/mini'

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
      encodeZodType: zodEnum(values as any),
      props: { values },
    })
  }
}

const _enum = EnumType.factory

export { _enum as enum }
