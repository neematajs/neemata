import { Temporal } from 'temporal-polyfill'

import {
  DurationType,
  PlainDateTimeType,
  PlainDateType,
  PlainMonthDayType,
  PlainTimeType,
  PlainYearMonthType,
  ZonedDateTimeType,
} from '../types/temporal.ts'

export const plainDate = PlainDateType.factory.bind(PlainDateType, Temporal)
export const plainDatetime = PlainDateTimeType.factory.bind(
  PlainDateTimeType,
  Temporal,
)
export const plainTime = PlainTimeType.factory.bind(PlainTimeType, Temporal)
export const zonedDatetime = ZonedDateTimeType.factory.bind(
  ZonedDateTimeType,
  Temporal,
)
export const duration = DurationType.factory.bind(DurationType, Temporal)
export const plainYearMonth = PlainYearMonthType.factory.bind(
  PlainYearMonthType,
  Temporal,
)
export const plainMonthDay = PlainMonthDayType.factory.bind(
  PlainMonthDayType,
  Temporal,
)
