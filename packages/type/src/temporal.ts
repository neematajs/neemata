import {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from './types/temporal.ts'

export const plainDate = () => new PlainDateType()
export const plainDatetime = () => new PlainDateTimeType()
export const plainTime = () => new PlainTimeType()
export const zonedDatetime = () => new ZonedDateTimeType()
export const duration = () => new DurationType()
export const plainYearMonth = () => new PlainYearMonthType()
export const plainMonthDay = () => new PlainMonthDayType()

export {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
}
