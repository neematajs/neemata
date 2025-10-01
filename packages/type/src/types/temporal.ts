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

type EncodedType = ZodMiniString<string>

export class PlainDateType extends TransformType<
  Temporal.PlainDate,
  EncodedType
> {
  static transformer = createTemporalTransformer('PlainDate')

  static factory() {
    return CustomType.factory<Temporal.PlainDate, EncodedType>({
      decode: PlainDateType.transformer.decode,
      encode: PlainDateType.transformer.encode,
      type: iso.date(),
      error: 'Invalid date format',
    })
  }
}

export class PlainDateTimeType extends TransformType<
  Temporal.PlainDateTime,
  EncodedType
> {
  static transformer = createTemporalTransformer('PlainDateTime')

  static factory() {
    return CustomType.factory<Temporal.PlainDateTime, EncodedType>({
      decode: PlainDateTimeType.transformer.decode,
      encode: PlainDateTimeType.transformer.encode,
      type: iso.datetime({ local: true }),
      error: 'Invalid datetime format',
    })
  }
}

export class ZonedDateTimeType extends TransformType<
  Temporal.ZonedDateTime,
  EncodedType
> {
  static transformer = createTemporalTransformer('ZonedDateTime', (value) =>
    Temporal.Instant.from(value).toZonedDateTimeISO('UTC'),
  )

  static factory() {
    return CustomType.factory<Temporal.ZonedDateTime, EncodedType>({
      decode: ZonedDateTimeType.transformer.decode,
      encode: ZonedDateTimeType.transformer.encode,
      type: iso.datetime({ local: true }),
      error: 'Invalid datetime format',
    })
  }
}

export class PlainTimeType extends TransformType<
  Temporal.PlainTime,
  EncodedType
> {
  static transformer = createTemporalTransformer('PlainTime')

  static factory() {
    return CustomType.factory<Temporal.PlainTime, EncodedType>({
      decode: PlainTimeType.transformer.decode,
      encode: PlainTimeType.transformer.encode,
      type: iso.time(),
      error: 'Invalid time format',
    })
  }
}

export class DurationType extends TransformType<
  Temporal.Duration,
  EncodedType
> {
  static transformer = createTemporalTransformer('Duration')

  static factory() {
    return CustomType.factory<Temporal.Duration, EncodedType>({
      decode: DurationType.transformer.decode,
      encode: DurationType.transformer.encode,
      type: iso.duration(),
      error: 'Invalid duration format',
    })
  }
}

export class PlainYearMonthType extends TransformType<
  Temporal.PlainYearMonth,
  EncodedType
> {
  static transformer = createTemporalTransformer('PlainYearMonth')

  static factory() {
    return CustomType.factory<Temporal.PlainYearMonth, EncodedType>({
      decode: PlainYearMonthType.transformer.decode,
      encode: PlainYearMonthType.transformer.encode,
      type: string().check(regex(/^\d{4}-\d{2}$/)),
      error: 'Invalid year-month format',
    })
  }
}

export class PlainMonthDayType extends TransformType<
  Temporal.PlainMonthDay,
  EncodedType
> {
  static transformer = createTemporalTransformer('PlainMonthDay')

  static factory() {
    return CustomType.factory<Temporal.PlainMonthDay, EncodedType>({
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
