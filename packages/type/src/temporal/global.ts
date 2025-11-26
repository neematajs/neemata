import 'temporal-spec/global'

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
  Temporal,
)
export const plainDatetime: () => PlainDateTimeType =
  PlainDateTimeType.factory.bind(PlainDateTimeType, Temporal)
export const plainTime: () => PlainTimeType = PlainTimeType.factory.bind(
  PlainTimeType,
  Temporal,
)
export const zonedDatetime: () => ZonedDateTimeType =
  ZonedDateTimeType.factory.bind(ZonedDateTimeType, Temporal)
export const duration: () => DurationType = DurationType.factory.bind(
  DurationType,
  Temporal,
)
export const plainYearMonth: () => PlainYearMonthType =
  PlainYearMonthType.factory.bind(PlainYearMonthType, Temporal)
export const plainMonthDay: () => PlainMonthDayType =
  PlainMonthDayType.factory.bind(PlainMonthDayType, Temporal)
