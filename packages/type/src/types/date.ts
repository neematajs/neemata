import type { ZodMiniDate, ZodMiniUnion } from 'zod/mini'
import { date as zodDate, iso, union } from 'zod/mini'

import { CustomType, TransformType } from './custom.ts'

export class DateType extends TransformType<
  Date,
  ZodMiniUnion<[iso.ZodMiniISODate, iso.ZodMiniISODateTime]>,
  ZodMiniDate<Date>
> {
  static factory(): DateType {
    return CustomType.factory<
      Date,
      ZodMiniUnion<[iso.ZodMiniISODate, iso.ZodMiniISODateTime]>,
      ZodMiniDate<Date>
    >({
      decode: (value) => new Date(value),
      encode: (value) => value.toISOString(),
      type: union([iso.date(), iso.datetime()]),
      decodedType: zodDate('Invalid Date'),
      error: 'Invalid date format',
      prototype: DateType.prototype,
    })
  }
}

export const date = DateType.factory
