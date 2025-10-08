import type { ZodMiniString } from 'zod/mini'
import { Temporal } from 'temporal-polyfill'
import { iso, regex, string } from 'zod/mini'

import { CustomType, TransformType } from './custom.ts'

type Types = Exclude<
  keyof typeof Temporal,
  'Now' | 'Instant' | 'Calendar' | 'TimeZone'
>

type TemporalTransformer<T extends Types> = {
  decode: (value: string) => ReturnType<(typeof Temporal)[T]['from']>
  encode: (value: ReturnType<(typeof Temporal)[T]['from']>) => string
}

const createTemporalTransformer = <T extends Types>(
  type: T,
  decode = (value: string) => Temporal[type].from(value),
) => {
  const encode = (value: ReturnType<(typeof Temporal)[T]['from']>) =>
    value.toString({
      calendarName: 'never',
      smallestUnit: 'microsecond',
      timeZoneName: 'never',
    })

  return { decode, encode } as TemporalTransformer<T>
}

type EncodeType = ZodMiniString<string>

export class PlainDateType extends TransformType<
  Temporal.PlainDate,
  EncodeType
> {
  static transformer = createTemporalTransformer('PlainDate')

  static factory() {
    return CustomType.factory<Temporal.PlainDate, EncodeType>({
      decode: PlainDateType.transformer.decode,
      encode: PlainDateType.transformer.encode,
      type: iso.date(),
      error: 'Invalid date format',
    })
  }
}

export class PlainDateTimeType extends TransformType<
  Temporal.PlainDateTime,
  EncodeType
> {
  static transformer = createTemporalTransformer('PlainDateTime')

  static factory() {
    return CustomType.factory<Temporal.PlainDateTime, EncodeType>({
      decode: PlainDateTimeType.transformer.decode,
      encode: PlainDateTimeType.transformer.encode,
      type: iso.datetime({ local: true }),
      error: 'Invalid datetime format',
    })
  }
}

export class ZonedDateTimeType extends TransformType<
  Temporal.ZonedDateTime,
  EncodeType
> {
  static transformer = createTemporalTransformer('ZonedDateTime', (value) =>
    Temporal.Instant.from(value).toZonedDateTimeISO('UTC'),
  )

  static factory() {
    return CustomType.factory<Temporal.ZonedDateTime, EncodeType>({
      decode: ZonedDateTimeType.transformer.decode,
      encode: ZonedDateTimeType.transformer.encode,
      type: iso.datetime({ local: true }),
      error: 'Invalid datetime format',
    })
  }
}

export class PlainTimeType extends TransformType<
  Temporal.PlainTime,
  EncodeType
> {
  static transformer = createTemporalTransformer('PlainTime')

  static factory() {
    return CustomType.factory<Temporal.PlainTime, EncodeType>({
      decode: PlainTimeType.transformer.decode,
      encode: PlainTimeType.transformer.encode,
      type: iso.time(),
      error: 'Invalid time format',
    })
  }
}

export class DurationType extends TransformType<Temporal.Duration, EncodeType> {
  static transformer = createTemporalTransformer('Duration')

  static factory() {
    return CustomType.factory<Temporal.Duration, EncodeType>({
      decode: DurationType.transformer.decode,
      encode: DurationType.transformer.encode,
      type: iso.duration(),
      error: 'Invalid duration format',
    })
  }
}

export class PlainYearMonthType extends TransformType<
  Temporal.PlainYearMonth,
  EncodeType
> {
  static transformer = createTemporalTransformer('PlainYearMonth')

  static factory() {
    return CustomType.factory<Temporal.PlainYearMonth, EncodeType>({
      decode: PlainYearMonthType.transformer.decode,
      encode: PlainYearMonthType.transformer.encode,
      type: string().check(regex(/^\d{4}-\d{2}$/)),
      error: 'Invalid year-month format',
    })
  }
}

export class PlainMonthDayType extends TransformType<
  Temporal.PlainMonthDay,
  EncodeType
> {
  static transformer = createTemporalTransformer('PlainMonthDay')

  static factory() {
    return CustomType.factory<Temporal.PlainMonthDay, EncodeType>({
      decode: PlainMonthDayType.transformer.decode,
      encode: PlainMonthDayType.transformer.encode,
      type: string().check(regex(/^\d{2}-\d{2}$/)),
      error: 'Invalid month-day format',
    })
  }
}

export const plainDate = PlainDateType.factory
export const plainDatetime = PlainDateTimeType.factory
export const plainTime = PlainTimeType.factory
export const zonedDatetime = ZonedDateTimeType.factory
export const duration = DurationType.factory
export const plainYearMonth = PlainYearMonthType.factory
export const plainMonthDay = PlainMonthDayType.factory
