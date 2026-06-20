import { Temporal } from 'temporal-polyfill'

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

export const plainDate = PlainDateType.factory.bind(
  PlainDateType,
  Temporal,
) as () => PlainDateType<typeof Temporal>

export const plainDatetime = PlainDateTimeType.factory.bind(
  PlainDateTimeType,
  Temporal,
) as () => PlainDateTimeType<typeof Temporal>

export const plainTime = PlainTimeType.factory.bind(
  PlainTimeType,
  Temporal,
) as () => PlainTimeType<typeof Temporal>

export const zonedDatetime = ZonedDateTimeType.factory.bind(
  ZonedDateTimeType,
  Temporal,
) as () => ZonedDateTimeType<typeof Temporal>

export const instant = InstantType.factory.bind(
  InstantType,
  Temporal,
) as () => InstantType<typeof Temporal>

export const duration = DurationType.factory.bind(
  DurationType,
  Temporal,
) as () => DurationType<typeof Temporal>

export const plainYearMonth = PlainYearMonthType.factory.bind(
  PlainYearMonthType,
  Temporal,
) as () => PlainYearMonthType<typeof Temporal>

export const plainMonthDay = PlainMonthDayType.factory.bind(
  PlainMonthDayType,
  Temporal,
) as () => PlainMonthDayType<typeof Temporal>
