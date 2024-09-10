import { t as baseT } from './index.ts'
import {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from './types/temporal.ts'

function extend<T extends typeof baseT>(value: T) {
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

export const t = extend(baseT)

export {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
}
