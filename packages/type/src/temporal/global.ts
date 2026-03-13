import {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from '../types/temporal.ts'

export const plainDate: () => PlainDateType = PlainDateType.factory.bind(
  PlainDateType,
  globalThis.Temporal,
)
export const plainDatetime: () => PlainDateTimeType =
  PlainDateTimeType.factory.bind(PlainDateTimeType, globalThis.Temporal)
export const plainTime: () => PlainTimeType = PlainTimeType.factory.bind(
  PlainTimeType,
  globalThis.Temporal,
)
export const zonedDatetime: () => ZonedDateTimeType =
  ZonedDateTimeType.factory.bind(ZonedDateTimeType, globalThis.Temporal)
export const duration: () => DurationType = DurationType.factory.bind(
  DurationType,
  globalThis.Temporal,
)
export const plainYearMonth: () => PlainYearMonthType =
  PlainYearMonthType.factory.bind(PlainYearMonthType, globalThis.Temporal)
export const plainMonthDay: () => PlainMonthDayType =
  PlainMonthDayType.factory.bind(PlainMonthDayType, globalThis.Temporal)
