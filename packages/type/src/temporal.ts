import type { t } from './index.ts'
import {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from './types/temporal.ts'

export function extend<T extends typeof t>(value: T) {
  return Object.assign({}, value, {
    temporal: {
      plainDate: () => new PlainDateType(),
      plainDatetime: () => new PlainDateTimeType(),
      plainTime: () => new PlainTimeType(),
      zonedDatetime: () => new ZonedDateTimeType(),
      duration: () => new DurationType(),
      plainYearMonth: () => new PlainYearMonthType(),
      plainMonthDay: () => new PlainMonthDayType(),
    },
  })
}

export {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
}
