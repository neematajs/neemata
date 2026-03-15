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
  // @ts-expect-error
  Temporal,
) as () => PlainDateType<
  // @ts-expect-error
  typeof Temporal
>

export const plainDatetime = PlainDateTimeType.factory.bind(
  PlainDateTimeType,
  // @ts-expect-error
  Temporal,
) as () => PlainDateTimeType<
  // @ts-expect-error
  typeof Temporal
>

export const plainTime = PlainTimeType.factory.bind(
  PlainTimeType,
  // @ts-expect-error
  Temporal,
) as () => PlainTimeType<
  // @ts-expect-error
  typeof Temporal
>

export const zonedDatetime = ZonedDateTimeType.factory.bind(
  ZonedDateTimeType,
  // @ts-expect-error
  Temporal,
) as () => ZonedDateTimeType<
  // @ts-expect-error
  typeof Temporal
>

export const instant = InstantType.factory.bind(
  InstantType,
  // @ts-expect-error
  Temporal,
) as () => InstantType<
  // @ts-expect-error
  typeof Temporal
>

export const duration = DurationType.factory.bind(
  DurationType,
  // @ts-expect-error
  Temporal,
) as () => DurationType<
  // @ts-expect-error
  typeof Temporal
>

export const plainYearMonth = PlainYearMonthType.factory.bind(
  PlainYearMonthType,
  // @ts-expect-error
  Temporal,
) as () => PlainYearMonthType<
  // @ts-expect-error
  typeof Temporal
>

export const plainMonthDay = PlainMonthDayType.factory.bind(
  PlainMonthDayType,
  // @ts-expect-error
  Temporal,
) as () => PlainMonthDayType<
  // @ts-expect-error
  typeof Temporal
>
