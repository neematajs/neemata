import type { ZodMiniUnion } from 'zod/mini'
import { iso, union } from 'zod/mini'

import { CustomType, TransformType } from './custom.ts'

export class DateType extends TransformType<
  Date,
  ZodMiniUnion<[iso.ZodMiniISODate, iso.ZodMiniISODateTime]>
> {
  static factory(): DateType {
    return CustomType.factory<
      Date,
      ZodMiniUnion<[iso.ZodMiniISODate, iso.ZodMiniISODateTime]>
    >({
      decode: (value) => new Date(value),
      encode: (value) => value.toISOString(),
      type: union([iso.date(), iso.datetime()]),
      prototype: DateType.prototype,
    })
  }
}

export const date = DateType.factory
