import {
  DurationType,
  InstantType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from '../types/temporal.ts'

export const plainDate = PlainDateType.factory.bind(PlainDateType)
export const plainDatetime = PlainDateTimeType.factory.bind(PlainDateTimeType)
export const plainTime = PlainTimeType.factory.bind(PlainTimeType)
export const zonedDatetime = ZonedDateTimeType.factory.bind(ZonedDateTimeType)
export const instant = InstantType.factory.bind(InstantType)
export const duration = DurationType.factory.bind(DurationType)
export const plainYearMonth =
  PlainYearMonthType.factory.bind(PlainYearMonthType)
export const plainMonthDay = PlainMonthDayType.factory.bind(PlainMonthDayType)
