import {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from './types/temporal.ts'

export const plainDate = PlainDateType
export const plainDatetime = PlainDateTimeType
export const plainTime = PlainTimeType
export const zonedDatetime = ZonedDateTimeType
export const duration = DurationType
export const plainYearMonth = PlainYearMonthType
export const plainMonthDay = PlainMonthDayType

export type {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
}
